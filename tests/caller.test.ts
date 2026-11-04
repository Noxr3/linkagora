import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_HEADER, resolveCallerWith, type CallerDeps, type Door } from '../lib/auth/caller.ts'
import { ACCOUNT_SCOPE, SCOPE } from '../lib/oauth/rules.ts'

const ADA = 'user-ada'
const BOB = 'user-bob'
const agents = [
  { id: 'id-ada-1', slug: 'ada-one', userId: ADA, shared: false },
  { id: 'id-ada-2', slug: 'ada-two', userId: ADA, shared: false },
  { id: 'id-bob', slug: 'bob', userId: BOB, shared: false },
  { id: 'id-shared', slug: 'shared', userId: ADA, shared: true },
]

/** The lookups as the database would answer them, read fresh on every call. */
function world() {
  const state = {
    agents: agents.map((agent) => ({ ...agent })),
    tokens: new Map<string, { agentId: string | null; userId: string; grantId: string; scope: string }>([
      ['oagt_app', { agentId: 'id-ada-1', userId: ADA, grantId: 'g-app', scope: SCOPE }],
      ['oagt_cli', { agentId: null, userId: ADA, grantId: 'g-cli', scope: ACCOUNT_SCOPE }],
    ]),
    keys: new Map([['oag_ada', { agentId: 'id-ada-1', keyId: 'k1' }]]),
  }
  const deps: CallerDeps = {
    async resolveKey(header) {
      return state.keys.get(header.replace(/^Bearer\s+/, '')) ?? null
    },
    async resolveToken(token) {
      return state.tokens.get(token) ?? null
    },
    async findAgent(ref) {
      const agent = state.agents.find((candidate) => candidate.id === ref || candidate.slug === ref)
      return agent ? { id: agent.id, userId: agent.userId, shared: agent.shared } : null
    },
  }
  return { state, deps }
}

const ask = (deps: CallerDeps, door: Door, authorization?: string, agent?: string) =>
  resolveCallerWith(
    deps,
    new Headers({ ...(authorization ? { authorization: `Bearer ${authorization}` } : {}), ...(agent ? { [AGENT_HEADER]: agent } : {}) }),
    door,
  )

const DOORS: Door[] = ['rest', 'relay', 'mcp']

test('no credential is nobody, not a refusal', async () => {
  const { deps } = world()
  for (const door of DOORS) assert.deepEqual(await ask(deps, door), { caller: null, refusal: null })
})

test('an agent key stands for its agent at every door, as before', async () => {
  const { deps } = world()
  for (const door of DOORS) {
    const { caller } = await ask(deps, door, 'oag_ada')
    assert.equal(caller?.kind, 'key')
    assert.equal(caller?.agentId, 'id-ada-1')
  }
})

test('an unknown credential is refused at every door', async () => {
  const { deps } = world()
  for (const door of DOORS) {
    assert.equal((await ask(deps, door, 'oag_nope')).refusal?.code, 'invalid_credential')
    assert.equal((await ask(deps, door, 'garbage')).refusal?.code, 'invalid_credential')
  }
})

test('a key cannot act as another agent, whatever a header says', async () => {
  const { deps } = world()
  assert.equal((await ask(deps, 'rest', 'oag_ada', 'id-ada-1')).caller?.agentId, 'id-ada-1')
  assert.equal((await ask(deps, 'rest', 'oag_ada', 'ada-one')).caller?.agentId, 'id-ada-1')
  for (const other of ['ada-two', 'bob', 'nobody']) {
    const { caller, refusal } = await ask(deps, 'rest', 'oag_ada', other)
    assert.equal(caller, null)
    assert.equal(refusal?.status, 403)
    assert.equal(refusal?.code, 'agent_mismatch')
  }
})

test('an app\'s token acts as its one agent, and only at /mcp, as its consent page says', async () => {
  const { deps } = world()
  assert.equal((await ask(deps, 'mcp', 'oagt_app')).caller?.agentId, 'id-ada-1')
  for (const door of ['rest', 'relay'] as const) {
    const { caller, refusal } = await ask(deps, door, 'oagt_app')
    assert.equal(caller, null)
    assert.equal(refusal?.code, 'wrong_door')
  }
  assert.equal((await ask(deps, 'mcp', 'oagt_app', 'ada-two')).refusal?.code, 'agent_mismatch')
})

test('the command line\'s token works at every door and acts as the agent each request names', async () => {
  const { deps } = world()
  for (const door of DOORS) {
    assert.equal((await ask(deps, door, 'oagt_cli', 'ada-one')).caller?.agentId, 'id-ada-1')
    assert.equal((await ask(deps, door, 'oagt_cli', 'ada-two')).caller?.agentId, 'id-ada-2')
    assert.equal((await ask(deps, door, 'oagt_cli', 'id-ada-2')).caller?.agentId, 'id-ada-2')
  }
})

test('naming no agent identifies the account but acts as nobody', async () => {
  const { deps } = world()
  const { caller } = await ask(deps, 'rest', 'oagt_cli')
  assert.equal(caller?.kind, 'oauth')
  assert.equal(caller?.agentId, null)
})

test('the command line\'s token cannot act as someone else\'s agent, the shared test agent, or nobody', async () => {
  const { deps } = world()
  for (const ref of ['bob', 'id-bob', 'shared', 'id-shared', 'nobody']) {
    const { caller, refusal } = await ask(deps, 'rest', 'oagt_cli', ref)
    assert.equal(caller, null, ref)
    assert.equal(refusal?.status, 403, ref)
    assert.equal(refusal?.code, 'not_your_agent', ref)
  }
})

test('a revoked sign-in is refused on the next request, at every door', async () => {
  const { state, deps } = world()
  assert.equal((await ask(deps, 'rest', 'oagt_cli', 'ada-one')).caller?.agentId, 'id-ada-1')
  state.tokens.delete('oagt_cli') // what oauth_resolve_access_token answers once the grant is revoked
  for (const door of DOORS) {
    const { caller, refusal } = await ask(deps, door, 'oagt_cli', 'ada-one')
    assert.equal(caller, null)
    assert.equal(refusal?.status, 401)
    assert.equal(refusal?.code, 'invalid_token')
  }
})

test('ownership is asked on each request: nothing is remembered between them', async () => {
  const { state, deps } = world()
  assert.equal((await ask(deps, 'rest', 'oagt_cli', 'ada-two')).caller?.agentId, 'id-ada-2')
  state.agents.find((agent) => agent.id === 'id-ada-2')!.userId = BOB
  assert.equal((await ask(deps, 'rest', 'oagt_cli', 'ada-two')).refusal?.code, 'not_your_agent')
})

test('the agent comes from the header alone: nothing in the request body is read', async () => {
  const seen: string[] = []
  const { deps } = world()
  const headers = new Headers({ authorization: 'Bearer oagt_cli' })
  const spying = new Proxy(headers, {
    get(target, property) {
      if (property === 'get') return (name: string) => (seen.push(name.toLowerCase()), target.get(name))
      return Reflect.get(target, property)
    },
  })
  await resolveCallerWith(deps, spying, 'rest')
  assert.deepEqual(new Set(seen), new Set(['authorization', AGENT_HEADER.toLowerCase()]))
})

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

test('every door goes through the one resolver', () => {
  const offenders = [...sources('app'), ...sources('lib')].filter((path) => {
    if (path === join('lib', 'auth', 'resolve-caller.ts') || path === join('lib', 'gateway', 'auth.ts') || path === join('lib', 'oauth', 'store.ts')) return false
    return /\b(resolveApiKey|resolveAccessToken)\b/.test(readFileSync(path, 'utf8'))
  })
  assert.deepEqual(offenders, [])
})

test('what a sign-in may never do stays key-only', () => {
  // A token that could mint a key could outlive its own revocation.
  const actor = readFileSync('lib/gateway/actor.ts', 'utf8')
  assert.match(actor, /caller\.kind === 'key' && caller\.agentId === agentId/)
  assert.match(readFileSync(join('app', 'api', 'agents', '[id]', 'route.ts'), 'utf8'), /keyAgent\(request\)/)
  for (const route of [join('app', 'api', 'keys', 'route.ts'), join('app', 'api', 'keys', '[id]', 'route.ts')]) {
    const source = readFileSync(route, 'utf8')
    assert.match(source, /canManageAgent/)
    assert.doesNotMatch(source, /actingAgent|agentActor/)
  }
})
