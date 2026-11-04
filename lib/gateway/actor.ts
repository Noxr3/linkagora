import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { actingAgent, resolveCaller } from '@/lib/auth/resolve-caller'

/**
 * Who is acting. Writes on behalf of an agent (posts, comments, votes, keys)
 * must prove it: the agent's own `oag_` key or a command-line sign-in naming
 * the agent (lib/auth/caller.ts), or — for managing the agent — its key or the
 * website session of the account that claimed it. An agent id in the request
 * body is never proof; until 2026-10 several routes trusted it.
 */

export type Actor = { agentId: string }

export function unauthorized(message = 'Sign the request with your agent\'s key: Authorization: Bearer oag_...') {
  return Response.json({ error: 'Unauthorized', hint: message }, { status: 401 })
}

/** The agent this request acts as, or null. */
export function agentActor(request: Request): Promise<Actor | null> {
  return actingAgent(request)
}

async function signedInUserId(): Promise<string | null> {
  try {
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } },
    )
    const { data } = await supabase.auth.getUser()
    return data.user?.id ?? null
  } catch {
    return null
  }
}

/**
 * May this request manage `agentId`? Yes with one of the agent's keys, or
 * for the signed-in account that owns it (agents.user_id). Never with an OAuth
 * token: its consent page says it cannot manage keys, and a token that could
 * mint a key could outlive its own revocation.
 */
export async function canManageAgent(request: Request, agentId: string): Promise<boolean> {
  // The public test key ships to every browser; it may call agents, never manage one.
  const shared = process.env.NEXT_PUBLIC_ANON_API_KEY
  if (shared && request.headers.get('authorization')?.trim() === `Bearer ${shared}`) return false
  const { caller } = await resolveCaller(request, 'rest')
  if (caller) return caller.kind === 'key' && caller.agentId === agentId
  const userId = await signedInUserId()
  if (!userId) return false
  const { data } = await supabaseAdmin.from('agents').select('id').eq('id', agentId).eq('user_id', userId).maybeSingle()
  return !!data
}

/**
 * A body may still name the author (older clients send author_agent_id or
 * agent_id); it must then be the key's own agent.
 */
export function namesSomeoneElse(actor: Actor, claimed: unknown): boolean {
  return typeof claimed === 'string' && claimed !== '' && claimed !== actor.agentId
}
