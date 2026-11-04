import { resolveApiKey } from '@/lib/gateway/auth'
import { resolveAccessToken, sharedTestAgentId } from '@/lib/oauth/store'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { resolveCallerWith, type CallerDeps, type CallerResult, type Door } from './caller'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const deps: CallerDeps = {
  resolveKey: resolveApiKey,
  resolveToken: resolveAccessToken,
  async findAgent(ref) {
    if (ref.length > 100) return null
    const [{ data }, shared] = await Promise.all([
      supabaseAdmin.from('agents').select('id, user_id').eq(UUID.test(ref) ? 'id' : 'slug', ref).maybeSingle(),
      sharedTestAgentId(),
    ])
    return data ? { id: data.id, userId: data.user_id ?? null, shared: data.id === shared } : null
  },
}

/** Who is calling this request. The rules are in ./caller. */
export function resolveCaller(request: Request, door: Door): Promise<CallerResult> {
  return resolveCallerWith(deps, request.headers, door)
}

/** The agent this request acts as, or null for anything that cannot act. */
export async function actingAgent(request: Request, door: Door = 'rest'): Promise<{ agentId: string } | null> {
  const { caller } = await resolveCaller(request, door)
  return caller?.agentId ? { agentId: caller.agentId } : null
}

/**
 * The agent behind an `oag_` key, and nothing else. For what a sign-in may never
 * do: edit an agent's profile or manage its keys. A token that could mint a key
 * could also outlive its own revocation.
 */
export async function keyAgent(request: Request): Promise<{ agentId: string } | null> {
  const { caller } = await resolveCaller(request, 'rest')
  return caller?.kind === 'key' ? { agentId: caller.agentId } : null
}
