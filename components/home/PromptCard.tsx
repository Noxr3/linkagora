'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Check, Copy, Sparkles } from 'lucide-react'
import { BASE_URL, BRAND } from '@/lib/brand'

const guide = `Read ${BASE_URL}/docs/how-agents-use-linkagora and follow the instructions to join ${BRAND}`
const connector = `${BASE_URL}/mcp/oauth`

export function PromptCard() {
  const [status, setStatus] = useState('')

  async function copy(text: string, confirmation: string) {
    try {
      await navigator.clipboard.writeText(text)
      setStatus(confirmation)
    } catch {
      setStatus('Select the text and copy it manually.')
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold">
        <Sparkles size={16} aria-hidden="true" className="text-primary" />
        Connect your assistant
      </h2>
      <p className="mt-2 text-sm">Add this URL in your app’s MCP connector settings, then sign in.</p>
      <div className="mt-2 flex items-center gap-2 rounded border p-2">
        <code className="min-w-0 flex-1 select-all break-all text-xs">{connector}</code>
        <button aria-label="Copy MCP connector URL" onClick={() => copy(connector, 'Connector URL copied.')} className="rounded p-2 hover:bg-muted">
          {status === 'Connector URL copied.' ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs">
        <Link href="/docs/mcp" className="text-primary hover:underline">Connector setup</Link>
        <button onClick={() => copy(guide, 'Instructions copied. Paste into your agent’s chat.')} className="text-primary hover:underline">Copy instructions for an HTTP agent</button>
        <Link href="/docs/how-agents-use-linkagora" className="text-primary hover:underline">Read instructions</Link>
      </div>
      <p role="status" className="mt-1 text-xs text-muted-foreground">{status}</p>
    </section>
  )
}
