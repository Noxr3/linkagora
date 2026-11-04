import { mkdirSync, rmdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir, type Env } from './config.ts'
import type { CredentialStore, Tokens } from './credentials.ts'
import { refreshTokens, TokenRefused } from './oauth.ts'

/**
 * Sending a request with whatever credential this computer has. A key from
 * LINKAGORA_API_KEY wins, for machines nobody signs in on; otherwise the saved
 * sign-in, renewed when it is about to expire or the server refuses it.
 */

const RENEW_EARLY_MS = 60_000
const LOCK_STALE_MS = 30_000

export class NotSignedIn extends Error {}

/**
 * One process at a time renews a sign-in. A refresh token works once and using a
 * spent one a minute later revokes the whole grant, so two terminals must never
 * both spend the same one.
 */
async function withRefreshLock<T>(dir: string, site: string, run: () => Promise<T>): Promise<T> {
  ensureDir(dir)
  const lock = join(dir, `refresh-${Buffer.from(site).toString('base64url')}.lock`)
  const deadline = Date.now() + LOCK_STALE_MS * 2
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch {
      let age = 0
      try {
        age = Date.now() - statSync(lock).mtimeMs
      } catch {
        continue // released between the two calls
      }
      if (age > LOCK_STALE_MS) {
        try {
          rmdirSync(lock)
        } catch {
          // someone else cleared it
        }
        continue
      }
      if (Date.now() > deadline) throw new Error('Another linkagora process is renewing this sign-in. Try again in a moment.')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  try {
    return await run()
  } finally {
    try {
      rmdirSync(lock)
    } catch {
      // already gone
    }
  }
}

export type Session = {
  site: string
  env: Env
  dir: string
  store: CredentialStore
  fetch: typeof fetch
}

export const apiKey = (env: Env) => env.LINKAGORA_API_KEY?.trim() || null

async function renew(session: Session, seen: Tokens): Promise<Tokens> {
  return withRefreshLock(session.dir, session.site, async () => {
    const stored = await session.store.get(session.site)
    if (!stored) throw new NotSignedIn('You are not signed in. Run: linkagora login')
    // Another terminal renewed it while this one waited: use theirs.
    if (stored.refresh_token !== seen.refresh_token) return stored
    let fresh: Tokens
    try {
      fresh = await refreshTokens(session.fetch, session.site, stored.refresh_token)
    } catch (error) {
      if (error instanceof TokenRefused && error.error === 'invalid_grant') {
        await session.store.delete(session.site)
        throw new NotSignedIn(`${error.message.replace(/\.?$/, '.')} Run: linkagora login`)
      }
      throw error
    }
    await session.store.set(session.site, fresh)
    return fresh
  })
}

/** `agent` goes out as the LinkAgora-Agent header; nothing is remembered on the server. */
export async function authorizedFetch(session: Session, path: string, options: { agent?: string; init?: RequestInit } = {}): Promise<Response> {
  const send = (credential: string) => {
    const headers = new Headers(options.init?.headers)
    headers.set('Authorization', `Bearer ${credential}`)
    headers.set('Accept', 'application/json')
    if (options.agent) headers.set('LinkAgora-Agent', options.agent)
    return session.fetch(new URL(path, session.site), { signal: AbortSignal.timeout(30_000), ...options.init, headers })
  }

  const key = apiKey(session.env)
  if (key) return send(key)

  let tokens = await session.store.get(session.site)
  if (!tokens) throw new NotSignedIn('You are not signed in. Run: linkagora login (or set LINKAGORA_API_KEY).')
  if (tokens.expires_at - Date.now() < RENEW_EARLY_MS) tokens = await renew(session, tokens)

  const response = await send(tokens.access_token)
  if (response.status !== 401) return response

  // Renewing tells a revoked sign-in (refused, and forgotten here) from a stale
  // access token. If it renews and the route still says 401, the sign-in is fine
  // and the route has its own reason, which the caller gets to read.
  tokens = await renew(session, tokens)
  return send(tokens.access_token)
}
