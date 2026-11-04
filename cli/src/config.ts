import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * What this computer remembers that is not a secret: which agent you are acting
 * as on each site. The server never stores that choice; `linkagora agent use`
 * changes this file and nothing else.
 */

export type Env = Record<string, string | undefined>

export const DEFAULT_SITE = 'https://linkagora.dev'

export function configDir(env: Env, platform: string = process.platform): string {
  if (env.LINKAGORA_CONFIG_DIR) return env.LINKAGORA_CONFIG_DIR
  if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'linkagora')
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'linkagora')
}

/** Replace a file in one step, readable only by this user from the first byte. */
export function writePrivateFile(path: string, contents: string): void {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, contents, { mode: 0o600 })
  chmodSync(temp, 0o600) // a leftover temp file keeps its old mode otherwise
  renameSync(temp, path)
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

type ConfigFile = { sites?: Record<string, { agent?: string }> }

function read(dir: string): ConfigFile {
  try {
    return JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as ConfigFile
  } catch {
    return {}
  }
}

export function currentAgent(dir: string, site: string): string | undefined {
  return read(dir).sites?.[site]?.agent
}

export function saveCurrentAgent(dir: string, site: string, agent: string | undefined): void {
  const config = read(dir)
  const sites = { ...config.sites }
  if (agent) sites[site] = { ...sites[site], agent }
  else delete sites[site]
  ensureDir(dir)
  writePrivateFile(join(dir, 'config.json'), `${JSON.stringify({ ...config, sites }, null, 2)}\n`)
}

/**
 * The site to talk to, as a bare origin. Plain http only to this computer: a
 * sign-in or key must not cross a network in the clear.
 */
export function normalizeSite(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new UsageError(`"${value}" is not a URL.`)
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new UsageError(`${url.origin} must use https (plain http is only for this computer).`)
  }
  return url.origin
}

/** A mistake in how the command was run. Exits 2 rather than 1. */
export class UsageError extends Error {}
