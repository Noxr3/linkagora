import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, statSync, chmodSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { run, type Io } from '../cli/src/main.ts'
import { chainedStore, fileStore, macKeychain, secretService, type RunCommand, type Tokens } from '../cli/src/credentials.ts'
import { s256 } from '../lib/oauth/rules.ts'

/**
 * The real command line against a server that keeps the promises of /oauth and
 * /api/whoami: PKCE, single-use codes, rotating refresh tokens whose replay
 * revokes the grant. The full stack (real routes, real SQL) was run separately;
 * see the pull request.
 */

const AGENTS = {
  'ada-one': { id: '11111111-1111-4111-8111-111111111111', slug: 'ada-one', name: 'Ada One' },
  'ada-two': { id: '22222222-2222-4222-8222-222222222222', slug: 'ada-two', name: 'Ada Two' },
}

type Grant = { revoked: boolean }

async function server(options: { agents?: (typeof AGENTS)['ada-one'][]; accessSeconds?: number } = {}) {
  const owned = options.agents ?? Object.values(AGENTS)
  const codes = new Map<string, { challenge: string; redirectUri: string; used: boolean; grant: Grant }>()
  const access = new Map<string, Grant>()
  const refresh = new Map<string, { grant: Grant; spent: boolean }>()
  const key = { 'oag_ada-one': AGENTS['ada-one'] } as Record<string, (typeof AGENTS)['ada-one']>
  const log: { path: string; method: string; agent: string | null; body: string }[] = []
  const stats = { refreshed: 0, replays: 0, lastAuthorize: null as URLSearchParams | null, consent: 'allow' as 'allow' | 'deny' }

  const pair = (grant: Grant) => {
    const a = `oagt_${randomBytes(12).toString('hex')}`
    const r = `oagr_${randomBytes(12).toString('hex')}`
    access.set(a, grant)
    refresh.set(r, { grant, spent: false })
    return { token_type: 'Bearer', access_token: a, refresh_token: r, expires_in: options.accessSeconds ?? 3600, scope: 'agents' }
  }
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString()
    const url = new URL(req.url ?? '/', 'http://x')
    const named = (req.headers['linkagora-agent'] as string | undefined) ?? null
    log.push({ path: url.pathname, method: req.method ?? '', agent: named, body: raw })

    if (url.pathname === '/oauth/authorize') {
      stats.lastAuthorize = url.searchParams
      const back = new URL(url.searchParams.get('redirect_uri')!)
      const state = url.searchParams.get('state')!
      back.searchParams.set('state', state)
      back.searchParams.set('iss', origin)
      if (stats.consent === 'deny') {
        back.searchParams.set('error', 'access_denied')
        back.searchParams.set('error_description', 'The account owner did not allow access.')
      } else {
        const code = randomBytes(16).toString('hex')
        codes.set(code, { challenge: url.searchParams.get('code_challenge')!, redirectUri: url.searchParams.get('redirect_uri')!, used: false, grant: { revoked: false } })
        back.searchParams.set('code', code)
      }
      res.writeHead(302, { Location: back.toString() })
      return res.end()
    }
    if (url.pathname === '/oauth/token') {
      const form = new URLSearchParams(raw)
      assert.equal(form.get('client_id'), 'linkagora-cli')
      if (form.get('grant_type') === 'authorization_code') {
        const code = codes.get(form.get('code') ?? '')
        if (!code || code.used) return send(res, 400, { error: 'invalid_grant', error_description: 'The authorization code is not valid.' })
        code.used = true
        if (s256(form.get('code_verifier') ?? '') !== code.challenge) return send(res, 400, { error: 'invalid_grant', error_description: 'code_verifier does not match the code_challenge.' })
        if (form.get('redirect_uri') !== code.redirectUri) return send(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri does not match.' })
        return send(res, 200, pair(code.grant))
      }
      const row = refresh.get(form.get('refresh_token') ?? '')
      if (!row) return send(res, 400, { error: 'invalid_grant', error_description: 'The refresh token is not valid.' })
      if (row.grant.revoked) return send(res, 400, { error: 'invalid_grant', error_description: 'Access was revoked. Sign in again.' })
      if (row.spent) {
        stats.replays++
        row.grant.revoked = true
        return send(res, 400, { error: 'invalid_grant', error_description: 'The refresh token was already used; access is revoked.' })
      }
      row.spent = true
      stats.refreshed++
      return send(res, 200, pair(row.grant))
    }
    if (url.pathname === '/oauth/revoke') {
      const token = new URLSearchParams(raw).get('token') ?? ''
      const grant = refresh.get(token)?.grant ?? access.get(token)
      if (grant) grant.revoked = true
      return send(res, 200, {})
    }
    if (url.pathname === '/api/whoami') {
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '')
      const asKey = key[bearer]
      if (asKey) {
        if (named && named !== asKey.slug && named !== asKey.id) return send(res, 403, { error: 'Forbidden', code: 'agent_mismatch', hint: `This key belongs to one agent, and it is not "${named}".` })
        return send(res, 200, { via: 'key', agent: asKey, account: null, agents: [asKey] })
      }
      const grant = access.get(bearer)
      if (!grant || grant.revoked) return send(res, 401, { error: 'Unauthorized', code: 'invalid_token', hint: 'Your sign-in expired or was revoked. Sign in again.' })
      const agent = named ? owned.find((candidate) => candidate.slug === named || candidate.id === named) : null
      if (named && !agent) return send(res, 403, { error: 'Forbidden', code: 'not_your_agent', hint: `Your account does not own an agent "${named}".` })
      return send(res, 200, { via: 'sign-in', agent: agent ?? null, account: { id: 'user-ada', email: 'ada@example.com' }, agents: owned })
    }
    send(res, 404, {})
  }
  const http = createServer((req, res) => void handler(req, res))
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`
  const revokeAll = () => {
    for (const grant of access.values()) grant.revoked = true
  }
  return { origin, log, stats, revokeAll, access, close: () => new Promise((resolve) => { http.closeAllConnections(); http.close(resolve) }) }
}

function harness(site: string, options: { dir?: string; env?: Record<string, string>; pasted?: () => string; platform?: string } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'linkagora-cli-'))
  const out: string[] = []
  const err: string[] = []
  const exec = async (...argv: string[]) => {
    out.length = 0
    err.length = 0
    const io: Io = {
      argv,
      env: { LINKAGORA_CONFIG_DIR: dir, LINKAGORA_URL: site, LINKAGORA_CREDENTIAL_STORE: 'file', ...options.env },
      platform: options.platform ?? 'darwin',
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      readLine: async () => (options.pasted ? options.pasted() : ''),
      // The browser: follows the redirect to wherever the site sends it.
      openBrowser: (url) => void fetch(url),
      fetch: globalThis.fetch,
      runCommand: async () => ({ code: 127, stdout: '' }),
      loginTimeoutMs: 5000,
    }
    const code = await run(io)
    return { code, out: out.join(''), err: err.join('') }
  }
  return { exec, dir, credentials: () => JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8')) as Record<string, Tokens> }
}

test('login: a browser, a loopback port and PKCE, and the sign-in is saved privately', async () => {
  const site = await server()
  const cli = harness(site.origin)
  const result = await cli.exec('login')
  assert.equal(result.code, 0, result.err)
  assert.match(result.out, /Signed in as ada@example\.com/)

  const asked = site.stats.lastAuthorize!
  assert.equal(asked.get('client_id'), 'linkagora-cli')
  assert.equal(asked.get('scope'), 'agents')
  assert.equal(asked.get('code_challenge_method'), 'S256')
  assert.equal(asked.get('resource'), site.origin)
  assert.match(asked.get('redirect_uri')!, /^http:\/\/127\.0\.0\.1:\d+\/callback$/)

  assert.ok(cli.credentials()[site.origin].access_token.startsWith('oagt_'))
  assert.equal(statSync(join(cli.dir, 'credentials.json')).mode & 0o777, 0o600)
  // Two agents: it does not pick one for you.
  assert.match(result.out, /Pick an agent: linkagora agent use <slug>/)
  assert.equal((await cli.exec('whoami')).out.includes('nobody yet'), true)
  await site.close()
})

test('login: with one agent, that is who you act as', async () => {
  const site = await server({ agents: [AGENTS['ada-one']] })
  const cli = harness(site.origin)
  assert.match((await cli.exec('login')).out, /Acting as ada-one, your only agent/)
  assert.match((await cli.exec('whoami')).out, /Acting as  ada-one \(Ada One\)/)
  await site.close()
})

test('login: refusing on the consent page says so and saves nothing', async () => {
  const site = await server()
  site.stats.consent = 'deny'
  const cli = harness(site.origin)
  const result = await cli.exec('login')
  assert.equal(result.code, 1)
  assert.match(result.err, /did not allow access/)
  assert.equal(existsSync(join(cli.dir, 'credentials.json')), false)
  await site.close()
})

test('login: another request to the loopback port cannot end or hijack the sign-in', async () => {
  const site = await server()
  const dir = mkdtempSync(join(tmpdir(), 'linkagora-cli-'))
  const answers: number[] = []
  const io: Io = {
    argv: ['login'],
    env: { LINKAGORA_CONFIG_DIR: dir, LINKAGORA_URL: site.origin, LINKAGORA_CREDENTIAL_STORE: 'file' },
    platform: 'darwin',
    stdout: () => {},
    stderr: () => {},
    readLine: async () => '',
    openBrowser: (url) => {
      void (async () => {
        const callback = new URL(new URL(url).searchParams.get('redirect_uri')!)
        // Any web page can poke a local port. Wrong state, wrong path: answered, ignored.
        answers.push((await fetch(`${callback.origin}/callback?code=stolen&state=wrong`)).status)
        answers.push((await fetch(`${callback.origin}/other`)).status)
        await fetch(url)
      })()
    },
    fetch: globalThis.fetch,
    runCommand: async () => ({ code: 127, stdout: '' }),
    loginTimeoutMs: 5000,
  }
  assert.equal(await run(io), 0)
  assert.deepEqual(answers, [400, 400])
  await site.close()
})

test('login over SSH: a link to open anywhere and a code to paste', async () => {
  const site = await server()
  let link = ''
  let opened = false
  const cli = harness(site.origin, { env: { SSH_CONNECTION: '1.2.3.4 1 5.6.7.8 22' } })
  const dir = cli.dir
  const err: string[] = []
  const io: Io = {
    argv: ['login'],
    env: { LINKAGORA_CONFIG_DIR: dir, LINKAGORA_URL: site.origin, LINKAGORA_CREDENTIAL_STORE: 'file', SSH_CONNECTION: '1.2.3.4 1 5.6.7.8 22' },
    platform: 'linux',
    stdout: () => {},
    stderr: (text) => err.push(text),
    readLine: async () => {
      // The person opens the printed link somewhere else and copies what the page shows.
      link = /(http\S+\/oauth\/authorize\S+)/.exec(err.join(''))![1]
      const landed = await fetch(link, { redirect: 'manual' })
      const back = new URL(landed.headers.get('location')!)
      return `${back.searchParams.get('code')}#${back.searchParams.get('state')}\n`
    },
    openBrowser: () => {
      opened = true
    },
    fetch: globalThis.fetch,
    runCommand: async () => ({ code: 127, stdout: '' }),
    loginTimeoutMs: 5000,
  }
  assert.equal(await run(io), 0, err.join(''))
  assert.equal(opened, false)
  assert.equal(new URL(link).searchParams.get('redirect_uri'), `${site.origin}/oauth/cli/callback`)
  assert.ok(cli.credentials()[site.origin])
  await site.close()
})

test('login --no-browser: a code from another sign-in, or half a code, is refused', async () => {
  const site = await server()
  for (const pasted of ['abc#some-other-state', 'just-the-code', '']) {
    const cli = harness(site.origin, { pasted: () => pasted })
    const result = await cli.exec('login', '--no-browser')
    assert.equal(result.code, 1, pasted)
    assert.equal(existsSync(join(cli.dir, 'credentials.json')), false, pasted)
  }
  assert.equal(site.log.some((entry) => entry.path === '/oauth/token'), false)
  await site.close()
})

test('a second login leaves no live sign-in behind', async () => {
  const site = await server()
  const cli = harness(site.origin)
  await cli.exec('login')
  const first = cli.credentials()[site.origin]
  await cli.exec('login')
  assert.notEqual(cli.credentials()[site.origin].access_token, first.access_token)
  assert.equal(site.access.get(first.access_token)?.revoked, true)
  await site.close()
})

test('agent use: only the local file changes, and every later request names the agent', async () => {
  const site = await server()
  const cli = harness(site.origin)
  await cli.exec('login')

  site.log.length = 0
  const used = await cli.exec('agent', 'use', 'ada-two')
  assert.equal(used.code, 0, used.err)
  assert.match(used.out, /Now acting as ada-two/)
  // One read to check the name; nothing written anywhere on the server.
  assert.deepEqual(site.log.map(({ method, path }) => `${method} ${path}`), ['GET /api/whoami'])
  assert.equal(JSON.parse(readFileSync(join(cli.dir, 'config.json'), 'utf8')).sites[site.origin].agent, 'ada-two')

  site.log.length = 0
  assert.match((await cli.exec('whoami')).out, /Acting as  ada-two/)
  assert.equal(site.log[0].agent, 'ada-two')

  // The same sign-in on another computer has its own choice: the server holds none.
  const elsewhere = harness(site.origin)
  await elsewhere.exec('login')
  assert.match((await elsewhere.exec('whoami')).out, /nobody yet/)
  assert.match((await cli.exec('whoami')).out, /Acting as  ada-two/)
  await site.close()
})

test('agent use: a name you do not own is refused and nothing is saved', async () => {
  const site = await server()
  const cli = harness(site.origin)
  await cli.exec('login')
  await cli.exec('agent', 'use', 'ada-one')
  const result = await cli.exec('agent', 'use', 'someone-else')
  assert.equal(result.code, 1)
  assert.match(result.err, /does not own an agent "someone-else"/)
  assert.match((await cli.exec('whoami')).out, /Acting as  ada-one/)
  await site.close()
})

test('--agent acts as that agent for one command and changes nothing', async () => {
  const site = await server()
  const cli = harness(site.origin)
  await cli.exec('login')
  await cli.exec('agent', 'use', 'ada-one')
  assert.match((await cli.exec('whoami', '--agent', 'ada-two')).out, /Acting as  ada-two/)
  assert.match((await cli.exec('--agent=ada-two', 'whoami')).out, /Acting as  ada-two/)
  assert.match((await cli.exec('whoami')).out, /Acting as  ada-one/)
  await site.close()
})

test('an agent that left your account stops working, and you can still list the others', async () => {
  const site = await server()
  const cli = harness(site.origin)
  await cli.exec('login')
  await cli.exec('agent', 'use', 'ada-one')
  // Saved locally, gone from the account.
  const config = join(cli.dir, 'config.json')
  writeFileSync(config, JSON.stringify({ sites: { [site.origin]: { agent: 'sold-agent' } } }))
  const who = await cli.exec('whoami')
  assert.equal(who.code, 1)
  assert.match(who.err, /does not own an agent "sold-agent".*agent list/)
  const list = await cli.exec('agent', 'list')
  assert.equal(list.code, 0, list.err)
  assert.match(list.out, /ada-one/)
  await site.close()
})

test('after the grant is revoked every command is refused and the sign-in is forgotten', async () => {
  const site = await server()
  const cli = harness(site.origin)
  await cli.exec('login')
  await cli.exec('agent', 'use', 'ada-one')
  assert.equal((await cli.exec('whoami')).code, 0)

  site.revokeAll() // the dashboard's Disconnect, or someone else's logout

  const refused = await cli.exec('whoami')
  assert.equal(refused.code, 1)
  assert.match(refused.err, /revoked/i)
  assert.match(refused.err, /linkagora login/)
  assert.equal(existsSync(join(cli.dir, 'credentials.json')), false)
  // And it stays refused, without asking the server again.
  site.log.length = 0
  const again = await cli.exec('agent', 'list')
  assert.equal(again.code, 1)
  assert.match(again.err, /not signed in/)
  assert.equal(site.log.length, 0)
  await site.close()
})

test('logout revokes on the server, not just here', async () => {
  const site = await server()
  const cli = harness(site.origin)
  await cli.exec('login')
  const { access_token } = cli.credentials()[site.origin]
  const result = await cli.exec('logout')
  assert.equal(result.code, 0)
  assert.equal(site.access.get(access_token)?.revoked, true)
  assert.equal(existsSync(join(cli.dir, 'credentials.json')), false)
  const bare = await fetch(`${site.origin}/api/whoami`, { headers: { Authorization: `Bearer ${access_token}` } })
  assert.equal(bare.status, 401)
  await site.close()
})

test('logout says so when the server could not be told', async () => {
  const site = await server()
  const cli = harness(site.origin)
  await cli.exec('login')
  await site.close()
  const result = await cli.exec('logout')
  assert.equal(result.code, 1)
  assert.match(result.err, /stays valid until it expires/)
  assert.equal(existsSync(join(cli.dir, 'credentials.json')), false)
})

test('an expired access token is renewed silently; the saved refresh token rotates', async () => {
  const site = await server({ accessSeconds: 0 })
  const cli = harness(site.origin)
  await cli.exec('login')
  const before = cli.credentials()[site.origin].refresh_token
  const refreshed = site.stats.refreshed
  assert.equal((await cli.exec('agent', 'use', 'ada-one')).code, 0)
  assert.ok(site.stats.refreshed > refreshed)
  assert.notEqual(cli.credentials()[site.origin].refresh_token, before)
  await site.close()
})

test('two terminals renewing at once spend the refresh token once', async () => {
  // A replay revokes the whole grant, so a race here would sign you out.
  const site = await server()
  const cli = harness(site.origin)
  await cli.exec('login')
  // Every terminal below starts out holding the same expired sign-in.
  const path = join(cli.dir, 'credentials.json')
  const saved = cli.credentials()
  saved[site.origin].expires_at = 0
  writeFileSync(path, JSON.stringify(saved))
  const results = await Promise.all(Array.from({ length: 6 }, () => cli.exec('agent', 'list')))
  assert.deepEqual(results.map((result) => result.code), [0, 0, 0, 0, 0, 0])
  assert.equal(site.stats.replays, 0)
  // The others wait, find the renewed sign-in saved, and use it.
  assert.equal(site.stats.refreshed, 1)
  await site.close()
})

test('LINKAGORA_API_KEY: no sign-in needed, nothing saved, and it wins over a saved sign-in', async () => {
  const site = await server()
  const cli = harness(site.origin, { env: { LINKAGORA_API_KEY: 'oag_ada-one' } })
  const who = await cli.exec('whoami')
  assert.equal(who.code, 0, who.err)
  assert.match(who.out, /an agent key/)
  assert.match(who.out, /Acting as  ada-one/)
  assert.equal(existsSync(join(cli.dir, 'credentials.json')), false)
  assert.equal(existsSync(join(cli.dir, 'config.json')), false)

  const signedIn = harness(site.origin)
  await signedIn.exec('login')
  await signedIn.exec('agent', 'use', 'ada-two')
  const both = harness(site.origin, { dir: signedIn.dir, env: { LINKAGORA_API_KEY: 'oag_ada-one' } })
  assert.match((await both.exec('whoami')).out, /Acting as  ada-one/) // not ada-two
  await site.close()
})

test('LINKAGORA_API_KEY stands for one agent: it cannot switch or sign in', async () => {
  const site = await server()
  const cli = harness(site.origin, { env: { LINKAGORA_API_KEY: 'oag_ada-one' } })
  assert.equal((await cli.exec('agent', 'use', 'ada-two')).code, 2)
  assert.equal((await cli.exec('login')).code, 2)
  const other = await cli.exec('whoami', '--agent', 'ada-two')
  assert.equal(other.code, 1)
  assert.match(other.err, /belongs to one agent/)
  assert.match((await harness(site.origin, { env: { LINKAGORA_API_KEY: 'oag_wrong' } }).exec('whoami')).err, /LINKAGORA_API_KEY was refused/)
  await site.close()
})

test('with nothing to go on it says how to start', async () => {
  const site = await server()
  const result = await harness(site.origin).exec('whoami')
  assert.equal(result.code, 1)
  assert.match(result.err, /linkagora login/)
  assert.match(result.err, /LINKAGORA_API_KEY/)
  assert.equal(site.log.length, 0)
  await site.close()
})

test('a credential never goes over plain http to another machine', async () => {
  const cli = harness('http://example.com', { env: { LINKAGORA_API_KEY: 'oag_x' } })
  const result = await cli.exec('whoami')
  assert.equal(result.code, 2)
  assert.match(result.err, /must use https/)
})

test('a sign-in saved for one site is not sent to another', async () => {
  const one = await server()
  const two = await server()
  const cli = harness(one.origin)
  await cli.exec('login')
  const other = await cli.exec('whoami', '--url', two.origin)
  assert.equal(other.code, 1)
  assert.equal(two.log.length, 0)
  await one.close()
  await two.close()
})

// ─── Where the sign-in is kept ──────────────────────────────────────────────

const TOKENS: Tokens = { access_token: 'oagt_secret-access', refresh_token: 'oagr_secret-refresh', expires_at: 1, scope: 'agents' }

/** A pretend `security` / `secret-tool` that remembers what it was given. */
function fakeKeychain() {
  const calls: { command: string; args: string[]; stdin?: string }[] = []
  let saved: string | null = null
  const run: RunCommand = async (command, args, stdin) => {
    calls.push({ command, args, stdin })
    if (args[0] === '-i') saved = /-w "([^"]+)"/.exec(stdin ?? '')?.[1] ?? null
    if (args[0] === 'store') saved = stdin ?? null
    if (args[0] === 'find-generic-password' || args[0] === 'lookup') return saved ? { code: 0, stdout: `${saved}\n` } : { code: 44, stdout: '' }
    if (args[0] === 'delete-generic-password' || args[0] === 'clear') saved = null
    return { code: 0, stdout: '' }
  }
  return { run, calls }
}

for (const [name, make] of [['macOS keychain', macKeychain], ['Linux keyring', secretService]] as const) {
  test(`${name}: round trip, with the secret never on a command line`, async () => {
    const { run, calls } = fakeKeychain()
    const store = make(run)
    await store.set('https://linkagora.dev', TOKENS)
    assert.deepEqual(await store.get('https://linkagora.dev'), TOKENS)
    await store.delete('https://linkagora.dev')
    assert.equal(await store.get('https://linkagora.dev'), null)
    const encoded = Buffer.from(JSON.stringify(TOKENS)).toString('base64')
    for (const call of calls) {
      const argv = call.args.join(' ')
      assert.ok(!argv.includes('secret-access') && !argv.includes(encoded), argv)
    }
    assert.ok(calls.some((call) => call.stdin?.includes(encoded)))
  })
}

test('macOS: a keychain that did not keep it counts as failing, even though `security -i` says fine', async () => {
  const store = macKeychain(async () => ({ code: 0, stdout: '' }))
  await assert.rejects(store.set('https://linkagora.dev', TOKENS))
})

test('no keychain: falls back to a file only you can read, and says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkagora-cli-'))
  const warnings: string[] = []
  const store = chainedStore(secretService(async () => ({ code: 127, stdout: '' })), fileStore(dir), (message) => warnings.push(message))
  await store.set('https://linkagora.dev', TOKENS)
  assert.deepEqual(await store.get('https://linkagora.dev'), TOKENS)
  assert.equal(statSync(join(dir, 'credentials.json')).mode & 0o777, 0o600)
  assert.match(warnings.join(''), /readable only by you/)
})

test('a keychain that comes back takes over from the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkagora-cli-'))
  const file = fileStore(dir)
  await file.set('https://linkagora.dev', TOKENS)
  const { run } = fakeKeychain()
  const store = chainedStore(macKeychain(run), file, () => {})
  assert.deepEqual(await store.get('https://linkagora.dev'), TOKENS)
  await store.set('https://linkagora.dev', { ...TOKENS, refresh_token: 'oagr_new' })
  assert.equal(existsSync(join(dir, 'credentials.json')), false)
  assert.equal((await store.get('https://linkagora.dev'))?.refresh_token, 'oagr_new')
})

test('secrets are private from the moment they are written, before anything reads them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkagora-cli-'))
  await fileStore(dir).set('https://linkagora.dev', TOKENS)
  assert.equal(statSync(join(dir, 'credentials.json')).mode & 0o777, 0o600)
  assert.equal(statSync(dir).mode & 0o777, 0o700)
})

test('a credentials file with looser permissions is tightened when read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkagora-cli-'))
  const store = fileStore(dir)
  await store.set('https://linkagora.dev', TOKENS)
  chmodSync(join(dir, 'credentials.json'), 0o644)
  await store.get('https://linkagora.dev')
  assert.equal(statSync(join(dir, 'credentials.json')).mode & 0o777, 0o600)
})
