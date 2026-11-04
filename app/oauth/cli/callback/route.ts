import { BRAND } from '@/lib/brand'

/**
 * Where `linkagora login --no-browser` sends the browser, for a command line on
 * a machine the browser cannot reach (SSH, a container). The page shows the code
 * to paste back. It is useless without the PKCE verifier the command line holds,
 * and it works once.
 *
 * A route rather than a page so no layout or analytics script ever sees the URL.
 */
function html(title: string, body: string, status: number) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;line-height:1.5">${body}`,
    {
      status,
      // Framing, referrer and script rules for this path are in next.config.ts.
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    },
  )
}

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const error = params.get('error')
  if (error) {
    const why = params.get('error_description') ?? error
    return html(`${BRAND} sign-in`, `<h1 style="font-size:1.25rem">Sign-in did not finish</h1><p>${escape(why)}</p><p>Go back to your terminal and run <code>linkagora login</code> again.</p>`, 400)
  }
  const code = params.get('code')
  const state = params.get('state')
  if (!code || !state) {
    return html(`${BRAND} sign-in`, '<h1 style="font-size:1.25rem">Nothing to show</h1><p>Start from your terminal: <code>linkagora login --no-browser</code>.</p>', 400)
  }
  return html(
    `${BRAND} sign-in`,
    `<h1 style="font-size:1.25rem">Paste this into your terminal</h1>
<p><code style="display:block;user-select:all;word-break:break-all;padding:.75rem;border:1px solid #8884;border-radius:.5rem">${escape(code)}#${escape(state)}</code></p>
<p>It works once, for five minutes, and only in the terminal that started this sign-in.</p>`,
    200,
  )
}
