import { supabaseAdmin } from '@/lib/supabase/admin'
import type { HealthStatus } from '@/lib/types/database'

// Vercel cron sends Authorization: Bearer <CRON_SECRET>
const CRON_SECRET = process.env.CRON_SECRET

// Probe timeout per agent
const PROBE_TIMEOUT_MS = 8_000

// Concurrent outbound probes. These never touch the database.
const CONCURRENCY = 20

// Agent ids per UPDATE, so the ids stay well inside a request URL's limit.
const UPDATE_CHUNK = 100

// An inbox agent is online while it keeps checking in.
const INBOX_ONLINE_MS = 15 * 60_000

function inboxStatus(lastSeenAt: string | null): HealthStatus {
  if (!lastSeenAt) return 'unknown'
  return Date.now() - Date.parse(lastSeenAt) < INBOX_ONLINE_MS ? 'online' : 'offline'
}

async function probeAgent(url: string): Promise<HealthStatus> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    })
    return res.ok ? 'online' : 'offline'
  } catch {
    return 'offline'
  }
}

async function runInBatches<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency)
    const batchResults = await Promise.all(batch.map(fn))
    results.push(...batchResults)
  }
  return results
}

function isAuthorized(request: Request): boolean {
  // Without a secret only local development may run this: every run probes every
  // agent and writes to the database, so it must not be open to the public.
  if (!CRON_SECRET) return process.env.NODE_ENV !== 'production'
  return request.headers.get('authorization') === `Bearer ${CRON_SECRET}`
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: agents, error } = await supabaseAdmin
    .from('agents')
    .select('id, url, delivery, last_seen_at')

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  if (!agents?.length) {
    return Response.json({ checked: 0 })
  }

  const checkedAt = new Date().toISOString()

  const results = await runInBatches(agents, CONCURRENCY, async (agent) => ({
    id: agent.id as string,
    status:
      agent.delivery === 'pull' || !agent.url ? inboxStatus(agent.last_seen_at) : await probeAgent(agent.url),
  }))

  // Inbox tasks nobody answered in time fail, and so does their call record.
  const { data: expired } = await supabaseAdmin
    .from('agent_tasks')
    .update({ state: 'failed', completed_at: checkedAt, updated_at: checkedAt, claimed_until: null })
    .in('state', ['submitted', 'working', 'input-required'])
    .lt('expires_at', checkedAt)
    .select('proxy_call_id')
  const expiredCalls = (expired ?? []).map((t) => t.proxy_call_id).filter((v): v is string => !!v)
  if (expiredCalls.length > 0) {
    await supabaseAdmin.from('proxy_calls').update({ status_code: 504 }).in('id', expiredCalls)
  }

  const summary: Record<HealthStatus, number> = { online: 0, offline: 0, unknown: 0 }
  const idsByStatus = new Map<HealthStatus, string[]>()
  for (const { id, status } of results) {
    summary[status]++
    idsByStatus.set(status, [...(idsByStatus.get(status) ?? []), id])
  }

  // A few UPDATEs in sequence, one per status, instead of one concurrent request
  // per agent: on a small database that burst is what fills the connection pool.
  let writeErrors = 0
  for (const [status, ids] of idsByStatus) {
    for (let i = 0; i < ids.length; i += UPDATE_CHUNK) {
      const { error: updateError } = await supabaseAdmin
        .from('agents')
        .update({ health_status: status, health_checked_at: checkedAt })
        .in('id', ids.slice(i, i + UPDATE_CHUNK))
      if (updateError) writeErrors++
    }
  }

  return Response.json(
    { checked: results.length, expired_tasks: expiredCalls.length, checkedAt, summary, writeErrors },
    { status: writeErrors ? 500 : 200 },
  )
}
