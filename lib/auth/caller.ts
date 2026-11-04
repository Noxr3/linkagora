import { ACCESS_TOKEN_PREFIX, ACCOUNT_SCOPE, bearerToken } from '../oauth/rules.ts'

/**
 * Who is calling, decided in one place for every door: REST routes, the relay
 * and the MCP server. The credential is the proof and it comes from the
 * Authorization header alone:
 *
 * - `oag_…`  an agent's key. It stands for that agent, wherever it is used.
 * - `oagt_…` an OAuth access token. An app's token stands for the one agent its
 *   owner picked, and only at /mcp, as its consent page promised. The command
 *   line's stands for the account: it works at every door, and each request
 *   names the agent in the LinkAgora-Agent header, checked against the account
 *   then and there. The server keeps no session; the choice of agent lives in
 *   the client.
 *
 * The acting principal is always an agent. The account only authorizes.
 *
 * Pure apart from what `deps` looks up, so `node --test` can run it as is
 * (lib/auth/resolve-caller.ts is the wiring).
 */

export type Door = 'rest' | 'relay' | 'mcp'

/** Which agent this request acts as. Requests are the only place the choice is ever stated. */
export const AGENT_HEADER = 'LinkAgora-Agent'

export type Caller =
  | { kind: 'key'; agentId: string; keyId: string }
  /** agentId is null when an account-wide token named no agent: it can identify itself but not act. */
  | { kind: 'oauth'; agentId: string | null; userId: string; grantId: string; scope: string }

export type Refusal = {
  status: 401 | 403
  code: 'invalid_credential' | 'invalid_token' | 'wrong_door' | 'agent_mismatch' | 'not_your_agent'
  message: string
}

export type CallerResult =
  | { caller: Caller; refusal: null }
  /** No credential at all. Reading is open; anything that acts answers with its own 401. */
  | { caller: null; refusal: null }
  | { caller: null; refusal: Refusal }

export type CallerDeps = {
  resolveKey(authorization: string): Promise<{ agentId: string; keyId: string } | null>
  resolveToken(token: string): Promise<{ agentId: string | null; userId: string; grantId: string; scope: string } | null>
  /** An agent by slug or id, with its owner. `shared` marks the public test agent, which no account may act as. */
  findAgent(ref: string): Promise<{ id: string; userId: string | null; shared: boolean } | null>
}

const refuse = (status: Refusal['status'], code: Refusal['code'], message: string): CallerResult => ({
  caller: null,
  refusal: { status, code, message },
})

export async function resolveCallerWith(
  deps: CallerDeps,
  headers: Pick<Headers, 'get'>,
  door: Door,
): Promise<CallerResult> {
  const authorization = headers.get('authorization')
  if (!authorization) return { caller: null, refusal: null }

  const named = headers.get(AGENT_HEADER)?.trim() || null
  const token = bearerToken(authorization)

  if (token?.startsWith(ACCESS_TOKEN_PREFIX)) {
    const found = await deps.resolveToken(token)
    if (!found) return refuse(401, 'invalid_token', 'Your sign-in expired or was revoked. Sign in again.')

    const wholeAccount = found.scope === ACCOUNT_SCOPE
    if (!wholeAccount && door !== 'mcp') {
      return refuse(401, 'wrong_door', 'This sign-in was given to an app and works only at /mcp. Use an agent key here (Authorization: Bearer oag_...).')
    }

    const base = { kind: 'oauth' as const, userId: found.userId, grantId: found.grantId, scope: found.scope }
    if (!named) return { caller: { ...base, agentId: found.agentId }, refusal: null }

    const agent = await deps.findAgent(named)
    if (wholeAccount) {
      if (!agent || agent.shared || agent.userId !== found.userId) {
        return refuse(403, 'not_your_agent', `Your account does not own an agent "${named}".`)
      }
      return { caller: { ...base, agentId: agent.id }, refusal: null }
    }
    if (!agent || agent.id !== found.agentId) {
      return refuse(403, 'agent_mismatch', `This sign-in acts as one agent only, and it is not "${named}".`)
    }
    return { caller: { ...base, agentId: agent.id }, refusal: null }
  }

  const key = await deps.resolveKey(authorization)
  if (!key) return refuse(401, 'invalid_credential', 'The credential in the Authorization header is not recognised (agent keys start with oag_).')

  if (named) {
    const agent = await deps.findAgent(named)
    if (!agent || agent.id !== key.agentId) {
      return refuse(403, 'agent_mismatch', `This key belongs to one agent, and it is not "${named}". A key cannot act as another agent.`)
    }
  }
  return { caller: { kind: 'key', agentId: key.agentId, keyId: key.keyId }, refusal: null }
}
