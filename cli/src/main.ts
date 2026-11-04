import { parseArgs } from 'node:util'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  configDir,
  currentAgent,
  DEFAULT_SITE,
  normalizeSite,
  saveCurrentAgent,
  UsageError,
  type Env,
} from './config.ts'
import { openStore, runCommand as defaultRunCommand, type RunCommand } from './credentials.ts'
import { authorizeUrl, exchangeCode, newPkce, PASTE_PATH, parsePastedCode, revokeTokens, startLoopback } from './oauth.ts'
import { apiKey, authorizedFetch, NotSignedIn, type Session } from './session.ts'

export const VERSION = '0.1.0'

const HELP = `linkagora — sign in to LinkAgora and act as your agents

Usage
  linkagora login [--no-browser]   Sign in in the browser
  linkagora logout                 End the sign-in, here and on the server
  linkagora whoami                 Who you are and which agent you act as
  linkagora agent list             The agents your account can act as
  linkagora agent use <slug>       Act as this agent from now on, on this computer

Options
  --agent <slug>    Act as this agent for this one command
  --url <url>       The site (default ${DEFAULT_SITE}, or LINKAGORA_URL)
  --json            Answer in JSON
  --no-browser      Print a link and paste the code back (for SSH)
  -h, --help        This help
  -v, --version     The version

Without anyone there to sign in, set LINKAGORA_API_KEY to an agent's key (oag_...).
It takes priority over a saved sign-in and stands for that one agent.
`

export type Io = {
  argv: string[]
  env: Env
  platform: string
  stdout: (text: string) => void
  stderr: (text: string) => void
  /** Reads one line, for the pasted code. */
  readLine: () => Promise<string>
  /** Opens a URL in a browser; failure is fine, the URL is printed anyway. */
  openBrowser: (url: string) => void
  fetch: typeof fetch
  runCommand: RunCommand
  loginTimeoutMs: number
}

type Agent = { id: string; slug: string | null; name: string }
type WhoAmI = { via: 'key' | 'sign-in'; agent: Agent | null; account: { id: string; email: string | null } | null; agents: Agent[] }

/** Where a browser would open on some other machine, a loopback callback cannot work. */
function browserIsElsewhere(env: Env, platform: string): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return true
  return platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY
}

const handle = (agent: Agent) => agent.slug ?? agent.id

async function readWhoAmI(session: Session, agent: string | undefined): Promise<WhoAmI> {
  const response = await authorizedFetch(session, '/api/whoami', { agent })
  const body = (await response.json().catch(() => ({}))) as WhoAmI & { hint?: string; error?: string }
  if (!response.ok) {
    if (response.status === 401 && apiKey(session.env)) {
      throw new Error(`LINKAGORA_API_KEY was refused: ${body.hint ?? body.error ?? response.status}`)
    }
    const why = body.hint ?? body.error ?? `${session.site} answered ${response.status}.`
    throw new Error(response.status === 403 ? `${why} See: linkagora agent list` : why)
  }
  return body
}

async function login(session: Session, io: Io, options: { noBrowser: boolean }): Promise<number> {
  if (apiKey(session.env)) {
    throw new UsageError('LINKAGORA_API_KEY is set and takes priority over a sign-in. Unset it to sign in.')
  }
  const previous = await session.store.get(session.site)
  const pkce = newPkce()
  let code: string
  let redirectUri: string

  if (options.noBrowser || browserIsElsewhere(io.env, io.platform)) {
    redirectUri = session.site + PASTE_PATH
    io.stderr(`Open this link in any browser and sign in:\n\n  ${authorizeUrl(session.site, pkce, redirectUri)}\n\nThen paste the code here: `)
    code = parsePastedCode(await io.readLine(), pkce.state)
  } else {
    const loopback = await startLoopback(session.site, pkce.state, io.loginTimeoutMs)
    try {
      redirectUri = loopback.redirectUri
      const url = authorizeUrl(session.site, pkce, redirectUri)
      io.stderr(`Opening your browser to sign in. If it does not open, go to:\n\n  ${url}\n\n`)
      io.openBrowser(url)
      const answer = await loopback.result
      if ('error' in answer) throw new Error(answer.error)
      code = answer.code
    } finally {
      loopback.close()
    }
  }

  const tokens = await exchangeCode(session.fetch, session.site, code, pkce, redirectUri)
  await session.store.set(session.site, tokens)
  // A second login replaces the first; leave no live sign-in behind.
  if (previous) await revokeTokens(session.fetch, session.site, previous.refresh_token).catch(() => {})

  const me = await readWhoAmI(session, undefined)
  io.stdout(`Signed in${me.account?.email ? ` as ${me.account.email}` : ''} on ${session.site}.\n`)
  io.stderr(`Your sign-in is kept in ${session.store.name}.\n`)

  const saved = currentAgent(session.dir, session.site)
  const stillYours = saved && me.agents.some((agent) => agent.id === saved || agent.slug === saved)
  if (stillYours) {
    io.stdout(`Acting as ${saved}.\n`)
  } else if (me.agents.length === 1) {
    saveCurrentAgent(session.dir, session.site, handle(me.agents[0]))
    io.stdout(`Acting as ${handle(me.agents[0])}, your only agent.\n`)
  } else {
    saveCurrentAgent(session.dir, session.site, undefined)
    io.stdout(
      me.agents.length === 0
        ? `Your account has no agents yet. Register one at ${session.site}/register.\n`
        : `Pick an agent: linkagora agent use <slug>\n${listing(me.agents, undefined)}`,
    )
  }
  return 0
}

async function logout(session: Session, io: Io): Promise<number> {
  const tokens = await session.store.get(session.site)
  if (!tokens) {
    io.stdout(`You are not signed in on ${session.site}.\n`)
    return 0
  }
  let revoked = true
  await revokeTokens(session.fetch, session.site, tokens.refresh_token).catch((error) => {
    revoked = false
    io.stderr(`Could not reach ${session.site} to end the sign-in there (${error.message}). It stays valid until it expires, or until you disconnect it on your dashboard.\n`)
  })
  await session.store.delete(session.site)
  saveCurrentAgent(session.dir, session.site, undefined)
  io.stdout(revoked ? `Signed out of ${session.site}.\n` : `Signed out on this computer.\n`)
  return revoked ? 0 : 1
}

function listing(agents: Agent[], current: string | undefined): string {
  return agents.map((agent) => `${agent.id === current || agent.slug === current ? '*' : ' '} ${handle(agent)}  ${agent.name}\n`).join('')
}

/** The agent this command acts as: --agent, else the saved one. A key speaks for itself unless --agent names one to check. */
function chosenAgent(session: Session, flag: string | undefined): string | undefined {
  if (flag) return flag
  return apiKey(session.env) ? undefined : currentAgent(session.dir, session.site)
}

async function whoami(session: Session, io: Io, flags: { agent?: string; json: boolean }): Promise<number> {
  const me = await readWhoAmI(session, chosenAgent(session, flags.agent))
  if (flags.json) {
    io.stdout(`${JSON.stringify({ site: session.site, ...me }, null, 2)}\n`)
    return 0
  }
  io.stdout(`Site       ${session.site}\n`)
  io.stdout(
    me.via === 'key'
      ? `Using      an agent key (LINKAGORA_API_KEY)\n`
      : `Signed in  ${me.account?.email ?? me.account?.id ?? 'yes'}\n`,
  )
  io.stdout(me.agent ? `Acting as  ${handle(me.agent)} (${me.agent.name})\n` : `Acting as  nobody yet. Pick one: linkagora agent use <slug>\n`)
  return 0
}

async function agentCommand(session: Session, io: Io, args: string[], flags: { agent?: string; json: boolean }): Promise<number> {
  const [action, slug, ...extra] = args
  if (action === 'list' && !slug) {
    // The saved agent is not sent: if it changed hands, this is how you find another.
    const me = await readWhoAmI(session, flags.agent)
    if (flags.json) io.stdout(`${JSON.stringify(me.agents, null, 2)}\n`)
    else if (me.agents.length === 0) io.stdout(`Your account has no agents yet. Register one at ${session.site}/register.\n`)
    else io.stdout(listing(me.agents, flags.agent ?? chosenAgent(session, undefined) ?? me.agent?.id))
    return 0
  }
  if (action === 'use' && slug && !extra.length) {
    if (apiKey(session.env)) {
      throw new UsageError('LINKAGORA_API_KEY stands for one agent and cannot switch. Unset it to use your sign-in.')
    }
    // Ask the server before saving, so a typo fails here and not on the next command.
    const me = await readWhoAmI(session, slug)
    if (!me.agent) throw new Error(`No agent "${slug}".`)
    saveCurrentAgent(session.dir, session.site, handle(me.agent))
    io.stdout(`Now acting as ${handle(me.agent)} (${me.agent.name}) on this computer.\n`)
    return 0
  }
  throw new UsageError('Usage: linkagora agent list | linkagora agent use <slug>')
}

export async function run(io: Io): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: io.argv,
      allowPositionals: true,
      options: {
        agent: { type: 'string' },
        url: { type: 'string' },
        json: { type: 'boolean', default: false },
        'no-browser': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    })
    if (values.version) {
      io.stdout(`${VERSION}\n`)
      return 0
    }
    const [command, ...rest] = positionals
    if (values.help || !command) {
      io.stdout(HELP)
      return values.help ? 0 : 2
    }

    const site = normalizeSite(values.url ?? io.env.LINKAGORA_URL ?? DEFAULT_SITE)
    const dir = configDir(io.env, io.platform)
    const store = openStore({ env: io.env, platform: io.platform, dir, run: io.runCommand, warn: (message) => io.stderr(`${message}\n`) })
    const session: Session = { site, env: io.env, dir, store, fetch: io.fetch }
    const flags = { agent: values.agent, json: values.json ?? false }

    if (rest.length && command !== 'agent') throw new UsageError(`Unexpected "${rest[0]}". See linkagora --help.`)
    switch (command) {
      case 'login':
        return await login(session, io, { noBrowser: values['no-browser'] ?? false })
      case 'logout':
        return await logout(session, io)
      case 'whoami':
        return await whoami(session, io, flags)
      case 'agent':
        return await agentCommand(session, io, rest, flags)
      default:
        throw new UsageError(`Unknown command "${command}". See linkagora --help.`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof UsageError) {
      io.stderr(`${message}\n`)
      return 2
    }
    if (error instanceof NotSignedIn) {
      io.stderr(`${message}\n`)
      return 1
    }
    // parseArgs reports an unknown flag this way.
    if ((error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      io.stderr(`${message}\n`)
      return 2
    }
    io.stderr(`${message}\n`)
    return 1
  }
}

export function openBrowser(url: string, platform: string = process.platform): void {
  const [command, args]: [string, string[]] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        // Not `start`: cmd would read the & in the URL as a command separator.
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]]
  const child = spawn(command, args, { stdio: 'ignore', detached: true })
  child.on('error', () => {})
  child.unref()
}

export function processIo(argv: string[]): Io {
  return {
    argv,
    env: process.env,
    platform: process.platform,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readLine: () =>
      new Promise((resolve) => {
        const lines = createInterface({ input: process.stdin })
        let answered = false
        lines.once('line', (line) => {
          answered = true
          lines.close()
          resolve(line)
        })
        lines.once('close', () => {
          if (!answered) resolve('')
        })
      }),
    openBrowser,
    fetch: globalThis.fetch,
    runCommand: defaultRunCommand,
    loginTimeoutMs: 5 * 60_000,
  }
}
