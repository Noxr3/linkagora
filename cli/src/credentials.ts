import { spawn } from 'node:child_process'
import { chmodSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir, writePrivateFile, type Env } from './config.ts'

/**
 * Where a sign-in is kept: the system keychain when there is one, otherwise a
 * file only this user can read (0600). One entry per site, so a token saved for
 * one site is never sent to another.
 *
 * Secrets never appear in a command's arguments, where any process could read
 * them: macOS gets them through `security -i` on stdin, Linux through
 * `secret-tool store`, which reads stdin.
 */

export type Tokens = {
  access_token: string
  refresh_token: string
  /** Milliseconds since the epoch. */
  expires_at: number
  scope: string
}

export type CredentialStore = {
  name: string
  get(site: string): Promise<Tokens | null>
  set(site: string, tokens: Tokens): Promise<void>
  delete(site: string): Promise<void>
}

export type RunCommand = (command: string, args: string[], stdin?: string) => Promise<{ code: number; stdout: string }>

export const runCommand: RunCommand = (command, args, stdin) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stdin.on('error', () => {}) // the command may exit before reading
    child.on('error', () => resolve({ code: 127, stdout: '' })) // not installed
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }))
    child.stdin.end(stdin ?? '')
  })

function decode(value: string): Tokens | null {
  try {
    const tokens = JSON.parse(Buffer.from(value.trim(), 'base64').toString('utf8')) as Tokens
    return tokens?.access_token && tokens?.refresh_token ? tokens : null
  } catch {
    return null
  }
}

const encode = (tokens: Tokens) => Buffer.from(JSON.stringify(tokens)).toString('base64')

export function macKeychain(run: RunCommand, service = 'linkagora-cli'): CredentialStore {
  return {
    name: 'the macOS keychain',
    async get(site) {
      const { code, stdout } = await run('security', ['find-generic-password', '-a', site, '-s', service, '-w'])
      return code === 0 ? decode(stdout) : null
    },
    async set(site, tokens) {
      // `security -i` reports success whatever a command inside it did, so read it back.
      await run('security', ['-i'], `add-generic-password -U -a "${site}" -s "${service}" -w "${encode(tokens)}"\n`)
      const saved = await this.get(site)
      if (saved?.refresh_token !== tokens.refresh_token) throw new Error('the keychain did not keep it')
    },
    async delete(site) {
      await run('security', ['delete-generic-password', '-a', site, '-s', service])
    },
  }
}

export function secretService(run: RunCommand, service = 'linkagora-cli'): CredentialStore {
  const attributes = (site: string) => ['service', service, 'account', site]
  return {
    name: 'the system keyring',
    async get(site) {
      const { code, stdout } = await run('secret-tool', ['lookup', ...attributes(site)])
      return code === 0 ? decode(stdout) : null
    },
    async set(site, tokens) {
      const { code } = await run('secret-tool', ['store', '--label=LinkAgora command line', ...attributes(site)], encode(tokens))
      if (code !== 0) throw new Error('the keyring is not available')
    },
    async delete(site) {
      await run('secret-tool', ['clear', ...attributes(site)])
    },
  }
}

export function fileStore(dir: string): CredentialStore {
  const path = join(dir, 'credentials.json')
  const read = (): Record<string, Tokens> => {
    try {
      chmodSync(path, 0o600) // repair a file someone copied or restored with looser permissions
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, Tokens>
    } catch {
      return {}
    }
  }
  const write = (all: Record<string, Tokens>) => {
    if (Object.keys(all).length === 0) return rmSync(path, { force: true })
    ensureDir(dir)
    writePrivateFile(path, `${JSON.stringify(all, null, 2)}\n`)
  }
  return {
    name: path,
    async get(site) {
      return read()[site] ?? null
    },
    async set(site, tokens) {
      write({ ...read(), [site]: tokens })
    },
    async delete(site) {
      const all = read()
      delete all[site]
      write(all)
    },
  }
}

/** The keychain, falling back to the file when saving to it fails; reads look in both. */
export function chainedStore(keychain: CredentialStore, file: CredentialStore, warn: (message: string) => void): CredentialStore {
  let saved = keychain.name
  return {
    get name() {
      return saved
    },
    async get(site) {
      return (await keychain.get(site).catch(() => null)) ?? (await file.get(site))
    },
    async set(site, tokens) {
      try {
        await keychain.set(site, tokens)
        saved = keychain.name
        await file.delete(site)
      } catch {
        saved = file.name
        await file.set(site, tokens)
        warn(`No system keychain available; keeping your sign-in in ${file.name} (readable only by you).`)
      }
    },
    async delete(site) {
      await keychain.delete(site).catch(() => {})
      await file.delete(site)
    },
  }
}

export function openStore(options: { env: Env; platform: string; dir: string; run: RunCommand; warn: (message: string) => void }): CredentialStore {
  const file = fileStore(options.dir)
  if (options.env.LINKAGORA_CREDENTIAL_STORE === 'file') return file
  if (options.platform === 'darwin') return chainedStore(macKeychain(options.run), file, options.warn)
  if (options.platform === 'linux') return chainedStore(secretService(options.run), file, options.warn)
  return file
}
