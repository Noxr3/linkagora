import { createHash } from 'node:crypto'
import { supabaseAdmin } from '@/lib/supabase/admin'

export async function POST(request: Request) {
  const token = /^Bearer (oag_[A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') ?? '')?.[1]
  if (!token) return Response.json({ error: 'Supply a locally generated 32-byte credential' }, { status: 401 })
  const body = await request.json().catch(() => null)
  if (typeof body?.name !== 'string' || !body.name.trim() || body.name.length > 80) {
    return Response.json({ error: 'Supply a name of 1 to 80 characters' }, { status: 400 })
  }
  const { data, error } = await supabaseAdmin.rpc('register_private_inbox', {
    p_name: body.name.trim(), p_hash: createHash('sha256').update(token).digest('hex'),
  })
  if (error || !data) return Response.json({ error: 'Registration unavailable' }, { status: 503 })
  return Response.json({ id: data, delivery: 'pull', visibility: 'private' }, { headers: { 'Cache-Control': 'no-store' } })
}
