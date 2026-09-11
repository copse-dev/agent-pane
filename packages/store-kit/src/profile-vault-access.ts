import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { VaultError } from './profile-vault-crypto.ts'

const GATE = '.vault-maintenance'
const CLIENTS = '.vault-clients'
function clientsDirectory(profile: string): string {
  const path = join(profile, CLIENTS)
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new VaultError('corrupt')
  return path
}
/** Headless clients register before opening stores and keep their lease until exit. */
export function registerVaultProfileClient(profile: string): () => void {
  const clients = clientsDirectory(profile)
  const lease = join(clients, `${String(process.pid)}-${randomUUID()}`)
  writeFileSync(lease, '', { flag: 'wx', mode: 0o600 })
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
  const release = (): void => {
    rmdirSync(gate)
  }
  try {
    for (const name of readdirSync(clients)) {
      const match = /^(\d+)-[a-f0-9-]{36}$/.exec(name)
      if (!match?.[1]) throw new VaultError('corrupt')
      const pid = Number(match[1])
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new VaultError('corrupt')
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
      if (alive)
        throw new Error('Close headless Copse clients before changing saved-secret encryption.')
      unlinkSync(join(clients, name))
    }
    return release
  } catch (error) {
    release()
    throw error
  }
}
/** A prior desktop may have crashed. The new single-instance owner retires its empty gate. */
export function retireVaultMaintenance(profile: string): void {
  const gate = join(profile, GATE)
  if (existsSync(gate)) rmdirSync(gate)
}
