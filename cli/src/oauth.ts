import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { Tokens } from './credentials.ts'

/**
 * Signing in, with the same /oauth endpoints every other app uses: an
 * authorization-code flow with PKCE, ending either at a one-shot server on
 * 127.0.0.1 or, where the browser is on another machine, at a page whose code
 * is pasted back.
 */

export const CLIENT_ID = 'linkagora-cli'
export const SCOPE = 'agents'
export const PASTE_PATH = '/oauth/cli/callback'

export type Pkce = { verifier: string; challenge: string; state: string }

export function newPkce(): Pkce {
  const verifier = randomBytes(48).toString('base64url')
  return {
    verifier,
    challenge: createHash('sha256').update(verifier, 'ascii').digest('base64url'),
    state: randomBytes(24).toString('base64url'),
  }
}

export function authorizeUrl(site: string, pkce: Pkce, redirectUri: string): string {
  const url = new URL('/oauth/authorize', site)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    scope: SCOPE,
    resource: site,
    state: pkce.state,
  }).toString()
  return url.toString()
}

const PAGE = (title: string, line: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">${title}</h1><p>${line}</p>`

/**
 * Wait for the browser to come back to 127.0.0.1. A request without the right
 * state is answered and ignored rather than ending the sign-in, since any page
 * in the browser can reach this port.
 */
export async function startLoopback(site: string, state: string, timeoutMs: number) {
  let settle: (result: { code: string } | { error: string }) => void = () => {}
  const result = new Promise<{ code: string } | { error: string }>((resolve) => (settle = resolve))
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const send = (status: number, html: string) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' })
      res.end(html)
    }
    if (url.pathname !== '/callback' || url.searchParams.get('state') !== state) {
      return send(400, PAGE('Not this sign-in', 'This does not match the sign-in your terminal is waiting for.'))
    }
    const iss = url.searchParams.get('iss')
    if (iss && iss !== site) {
      send(400, PAGE('Not this sign-in', 'The answer came from a different site.'))
      return settle({ error: `The answer came from ${iss}, not ${site}.` })
    }
    const code = url.searchParams.get('code')
    if (!code) {
      send(400, PAGE('Sign-in did not finish', 'You can close this tab and try again from your terminal.'))
      return settle({ error: url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? 'The sign-in did not finish.' })
    }
    send(200, PAGE('Signed in', 'You can close this tab and go back to your terminal.'))
    settle({ code })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as { port: number }
  const timer = setTimeout(() => settle({ error: 'Timed out waiting for the browser. Run linkagora login again.' }), timeoutMs)
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    result,
    close() {
      clearTimeout(timer)
      server.closeAllConnections()
      server.close()
    },
  }
}

/** A pasted `code#state` → the code, once the state proves it answers this sign-in. */
export function parsePastedCode(pasted: string, state: string): string {
  const text = pasted.trim()
  const split = text.lastIndexOf('#')
  if (split <= 0) throw new Error('That is not the whole code: copy everything on the page, including the part after #.')
  if (text.slice(split + 1) !== state) throw new Error('That code answers a different sign-in. Use the link printed above.')
  return text.slice(0, split)
}

type TokenAnswer = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string }

export class TokenRefused extends Error {
  readonly error: string
  constructor(error: string, description: string) {
    super(description)
    this.error = error
  }
}

async function tokenRequest(fetchImpl: typeof fetch, site: string, params: Record<string, string>): Promise<Tokens> {
  const response = await fetchImpl(new URL('/oauth/token', site), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = (await response.json().catch(() => ({}))) as TokenAnswer
  if (!response.ok || !body.access_token || !body.refresh_token) {
    throw new TokenRefused(body.error ?? 'server_error', body.error_description ?? `The sign-in server answered ${response.status}.`)
  }
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Date.now() + (body.expires_in ?? 3600) * 1000,
    scope: body.scope ?? '',
  }
}

export function exchangeCode(fetchImpl: typeof fetch, site: string, code: string, pkce: Pkce, redirectUri: string) {
  return tokenRequest(fetchImpl, site, { grant_type: 'authorization_code', code, code_verifier: pkce.verifier, redirect_uri: redirectUri, resource: site })
}

export function refreshTokens(fetchImpl: typeof fetch, site: string, refreshToken: string) {
  return tokenRequest(fetchImpl, site, { grant_type: 'refresh_token', refresh_token: refreshToken })
}

/** Ends the whole sign-in on the server (RFC 7009). */
export async function revokeTokens(fetchImpl: typeof fetch, site: string, token: string): Promise<void> {
  const response = await fetchImpl(new URL('/oauth/revoke', site), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, token }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`The sign-in server answered ${response.status}.`)
}
