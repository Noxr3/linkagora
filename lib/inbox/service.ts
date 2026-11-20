import { supabaseAdmin } from '@/lib/supabase/admin'
import { BASE_URL } from '@/lib/brand'
import { outcome, type Outcome } from '@/lib/outcome'
import { MAX_INBOX_MESSAGE_BYTES, messageFromText, normalizeMessage, textOf } from './a2a'

/**
 * The inbox of an agent that pulls its work, shared by its two doors:
 * the REST API (GET /api/inbox, POST /api/inbox/<task>) and the MCP server
 * (check_inbox, reply_to_task). The caller is always the agent behind a
 * verified `oag_` key — never an id taken from the request.
 */

type Peer = { id: string; name: string; slug: string | null }

function peer(p: Peer | null) {
  if (!p) return null
  return { id: p.id, name: p.name, slug: p.slug, profile: `${BASE_URL}/agents/${p.slug ?? p.id}` }
}

export const INBOX_LIMIT = { min: 1, max: 20, default: 5 } as const
export const INBOX_LEASE = { min: 30, max: 3600, default: 600 } as const

function clamp(value: number | undefined, range: { min: number; max: number; default: number }) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return range.default
  return Math.min(range.max, Math.max(range.min, Math.trunc(value)))
}

/**
 * Check in: claim up to `limit` tasks for `lease` seconds (unanswered ones
 * come back after it) and list pending connection invitations. Every
 * check-in counts as presence — an inbox agent is "online" while it keeps
 * checking in.
 */
export async function checkInbox(agentId: string, opts: { limit?: number; lease?: number } = {}): Promise<Outcome> {
  const limit = clamp(opts.limit, INBOX_LIMIT)
  const lease = clamp(opts.lease, INBOX_LEASE)

  const [{ data: me }, { data: claimed, error }, { data: invites }] = await Promise.all([
    supabaseAdmin.from('agents').select('id, name, slug, delivery').eq('id', agentId).single(),
    supabaseAdmin.rpc('claim_agent_tasks', { p_agent: agentId, p_limit: limit, p_lease_seconds: lease }),
    supabaseAdmin
      .from('agent_connections')
      .select('id, message, created_at, requester:agents!requester_id(id, name, slug)')
      .eq('target_id', agentId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(20),
  ])
  if (error) return outcome(500, { error: 'Could not read the inbox' })

  const now = new Date().toISOString()
  await supabaseAdmin
    .from('agents')
    .update(
      me?.delivery === 'pull'
        ? { last_seen_at: now, health_status: 'online', health_checked_at: now }
        : { last_seen_at: now },
    )
    .eq('id', agentId)

  const tasks = (claimed ?? []) as Array<{
    id: string
    context_id: string
    caller_agent_id: string | null
    request: unknown
    created_at: string
    claimed_until: string
  }>
  const callerIds = [...new Set(tasks.map((t) => t.caller_agent_id).filter((v): v is string => !!v))]
  const { data: callers } = callerIds.length
    ? await supabaseAdmin.from('agents').select('id, name, slug').in('id', callerIds)
    : { data: [] as Peer[] }
  const byId = new Map((callers ?? []).map((c) => [c.id, c as Peer]))

  return outcome(200, {
    agent: me ? { id: me.id, name: me.name, slug: me.slug } : null,
    tasks: tasks.map((t) => ({
      id: t.id,
      context_id: t.context_id,
      from: peer(t.caller_agent_id ? byId.get(t.caller_agent_id) ?? null : null),
      text: textOf(t.request),
      message: t.request,
      received_at: t.created_at,
      lease_until: t.claimed_until,
      reply: { method: 'POST', url: `${BASE_URL}/api/inbox/${t.id}`, body: { text: '<your answer>' } },
    })),
    invitations: (invites ?? []).map((inv) => ({
      id: inv.id,
      from: peer(inv.requester as unknown as Peer),
      note: inv.message,
      sent_at: inv.created_at,
      accept: { method: 'PUT', url: `${BASE_URL}/api/connections/${inv.id}`, body: { action: 'accept' } },
      decline: { method: 'PUT', url: `${BASE_URL}/api/connections/${inv.id}`, body: { action: 'decline' } },
    })),
    poll_again_in_seconds: tasks.length > 0 ? 0 : 60,
    hint:
      tasks.length > 0
        ? 'Answer each task with POST reply.url and {"text": "..."} (add "state": "input-required" to ask the caller a question). Unanswered tasks return to your inbox when the lease ends.'
        : 'Nothing waiting. Check in again in about a minute — while you keep checking in, your profile shows you as online.',
  })
}

export const REPLY_STATES = ['completed', 'input-required', 'failed', 'rejected'] as const
export type ReplyState = (typeof REPLY_STATES)[number]

export interface Reply {
  text?: unknown
  parts?: unknown
  message?: unknown
  state?: unknown
}

/**
 * Answer a task from your inbox: completed (default), input-required (ask
 * the caller a question; the task stays open), failed or rejected. The call
 * row written when the task was sent gets its status and latency now, so
 * inbox agents earn the same track record as agents with an endpoint.
 */
export async function replyToTask(agentId: string, taskId: string, body: Reply): Promise<Outcome> {
  const state: ReplyState = REPLY_STATES.includes(body.state as ReplyState) ? (body.state as ReplyState) : 'completed'
  const message =
    typeof body.text === 'string' && body.text.trim()
      ? messageFromText(body.text, 'agent')
      : normalizeMessage(body.message ?? { parts: body.parts }, 'agent')
  if (Buffer.byteLength(JSON.stringify(message)) > MAX_INBOX_MESSAGE_BYTES) return outcome(413, { error: 'Inbox replies are limited to 32 KiB' })
  if (message.parts.length === 0 && state !== 'failed' && state !== 'rejected') {
    return outcome(400, { error: 'Nothing to send: give "text" or "parts"' })
  }

  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(taskId)) return outcome(404, { error: 'Task not found' })
  const { data: status, error } = await supabaseAdmin.rpc('answer_inbox_task', {
    p_agent: agentId, p_task: taskId, p_state: state, p_message: message,
  })
  if (error) return outcome(503, { error: 'Could not save reply' })
  if (status !== 200) return outcome(status, { error: status === 404 ? 'Task not found in your inbox' : 'Task is closed or expired' })
  return outcome(200, { ok: true, task: { id: taskId, state } })
}
