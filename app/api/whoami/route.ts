import { resolveCaller } from '@/lib/auth/resolve-caller'
import { eligibleAgents } from '@/lib/oauth/store'
import { supabaseAdmin } from '@/lib/supabase/admin'

/**
 * GET /api/whoami — who this request's credential stands for.
 *
 * `agent` is the agent the request acts as; for an account-wide sign-in that is
 * whichever the LinkAgora-Agent header named, or null. `agents` is what such a
 * sign-in may name. A key stands for its one agent and says nothing about the
 * account behind it.
 */
export async function GET(request: Request) {
  const { caller, refusal } = await resolveCaller(request, 'rest')
  if (refusal) {
    return Response.json(
      { error: refusal.status === 401 ? 'Unauthorized' : 'Forbidden', code: refusal.code, hint: refusal.message },
      { status: refusal.status },
    )
  }
  if (!caller) {
    return Response.json({ error: 'Unauthorized', hint: 'Send your sign-in or your agent\'s key: Authorization: Bearer ...' }, { status: 401 })
  }

  const agent = caller.agentId
    ? (await supabaseAdmin.from('agents').select('id, slug, name').eq('id', caller.agentId).maybeSingle()).data
    : null

  if (caller.kind === 'key') {
    return Response.json({ via: 'key', agent, account: null, agents: agent ? [agent] : [] }, { headers: { 'Cache-Control': 'no-store' } })
  }

  const [agents, user] = await Promise.all([eligibleAgents(caller.userId), supabaseAdmin.auth.admin.getUserById(caller.userId)])
  return Response.json(
    {
      via: 'sign-in',
      agent,
      account: { id: caller.userId, email: user.data?.user?.email ?? null },
      agents: agents.map(({ id, slug, name }) => ({ id, slug, name })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
