import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { VaultError } from './profile-vault-crypto.ts'

const GATE = '.vault-maintenance'
const CLIENTS = '.vault-clients'
const LINUX_INSTANCE = /^linux:[a-f0-9-]{36}:\d+$/
const MAC_INSTANCE = /^darwin:[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/

/** Birth identity, never elapsed time or a process name. A collision only keeps a lease locked. */
function processInstance(pid: number): string {
  if (process.platform === 'linux') {
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
    // comm may contain spaces and parentheses; fields after its last ')' start at field 3.
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
    const identity = `linux:${boot}:${start ?? ''}`
    if (!LINUX_INSTANCE.test(identity)) throw new VaultError('unavailable')
    return identity
  }
  if (process.platform === 'darwin') {
    const birth = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      timeout: 2_000,
      maxBuffer: 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    const identity = `darwin:${birth}`
    if (!MAC_INSTANCE.test(identity)) throw new VaultError('unavailable')
    return identity
  }
  // Unsupported platforms retain the conservative legacy PID-only protocol.
  return ''
}

function leaseInstance(path: string): string {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) throw new VaultError('corrupt')
  const value = readFileSync(path, 'utf8')
  if (value !== '' && !LINUX_INSTANCE.test(value) && !MAC_INSTANCE.test(value))
    throw new VaultError('corrupt')
  return value
}
function clientsDirectory(profile: string): string {
  const path = join(profile, CLIENTS)
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new VaultError('corrupt')
  // mkdir's mode applies only to a new directory. An existing directory must
  // not let another user inspect or replace the leases used for exclusion.
  if (
    process.platform !== 'win32' &&
    ((stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid?.())
  )
    throw new VaultError('corrupt')
  return path
}
/** Headless clients register before opening stores and keep their lease until exit. */
export function registerVaultProfileClient(profile: string): () => void {
  const clients = clientsDirectory(profile)
  const lease = join(clients, `${String(process.pid)}-${randomUUID()}`)
  writeFileSync(lease, processInstance(process.pid), { flag: 'wx', mode: 0o600 })
  const release = (): void => {
    if (existsSync(lease)) unlinkSync(lease)
  }
  if (existsSync(join(profile, GATE))) {
    release()
    throw new VaultError('locked')
  }
  return release
}
/** Only the desktop holding Electron's single-instance lock may call this. */
export function acquireVaultMaintenance(profile: string): () => void {
  const clients = clientsDirectory(profile)
  const gate = join(profile, GATE)
  mkdirSync(gate, { mode: 0o700 })
  // Idempotent: a gate already retired (or removed by hand) must not turn the
  // caller's cleanup into a throw that skips the rest of its `finally`.
  const release = (): void => {
    removeGate(gate)
  }
  try {
    for (const name of readdirSync(clients)) {
      const match = /^(\d+)-[a-f0-9-]{36}$/.exec(name)
      if (!match?.[1]) throw new VaultError('corrupt')
      const pid = Number(match[1])
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new VaultError('corrupt')
      const path = join(clients, name)
      const registeredInstance = leaseInstance(path)
      let alive = true
      try {
        process.kill(pid, 0)
      } catch (error) {
        if (
          error instanceof Error &&
          Object.hasOwn(error, 'code') &&
          Reflect.get(error, 'code') === 'ESRCH'
        )
          alive = false
      }
      if (alive) {
        // Empty legacy records cannot prove which process owned the PID. A failed
        // OS probe also throws, leaving the lease and original storage untouched.
        const currentInstance = registeredInstance === '' ? '' : processInstance(pid)
        if (currentInstance === '' || currentInstance === registeredInstance)
          throw new Error('Close headless Copse clients before changing saved-secret encryption.')
      }
      unlinkSync(path)
    }
    return release
  } catch (error) {
    release()
    throw error
  }
}
/** A prior desktop may have crashed. The new single-instance owner retires its empty gate. */
export function retireVaultMaintenance(profile: string): void {
  removeGate(join(profile, GATE))
}
function removeGate(gate: string): void {
  try {
    rmdirSync(gate)
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        Object.hasOwn(error, 'code') &&
        Reflect.get(error, 'code') === 'ENOENT'
      )
    )
      throw error
  }
}
