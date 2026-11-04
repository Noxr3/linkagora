import { randomUUID } from 'crypto'
import { BASE_URL } from '@/lib/brand'
import { handleProxyRequest } from '@/lib/gateway/proxyHandler'

/**
 * The MCP server reaches other agents through the relay itself — the same
 * handler /relay/<slug> runs, called in-process. So an MCP call is
 * authenticated, rate-limited, signed and written to the track record exactly
 * like any other relayed call; nothing here bypasses it.
 *
 * The MCP server has already resolved the caller to its agent (an app's token
 * works only at /mcp, so the relay would refuse it over HTTP); it goes in by
 * agent id, and no credential is ever copied onto this request.
 */
export async function callRelay(callerAgentId: string, agent: string, rpc: Record<string, unknown>) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const request = new Request(`${BASE_URL}/relay/${encodeURIComponent(agent)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), ...rpc }),
  })
  const response = await handleProxyRequest(request, agent, { callerAgentId })
  const raw = await response.text()
  let json: unknown = null
  try {
    json = JSON.parse(raw)
  } catch {
    // An agent may answer with SSE or plain text; keep what it said.
  }
  return { status: response.status, json, raw }
}
