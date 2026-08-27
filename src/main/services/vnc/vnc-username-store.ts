import { createHash } from 'node:crypto'
import type { VncTarget } from '@shared/types/vnc.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { getSecretCipher, type SecretCipher } from '../storage/secret-cipher.ts'
import { registerSecretSweep, requestSecretSweep } from '../storage/secret-migration.ts'
import { deleteSetting, getSetting, setSetting } from '../storage/settings.ts'

const VNC_USERNAME_SETTING_ROOT = 'vncUsername'
const VNC_USERNAME_SETTING_PREFIX = `${VNC_USERNAME_SETTING_ROOT}.`
const VNC_PASSWORD_SETTING_PREFIX = 'vncPassword.'

interface StoredVncUsername {
  v: 1
  enc: string
}

export interface VncUsernameStoreDependencies {
  getCipher: () => SecretCipher | null
  read: (key: string) => unknown
  write: (key: string, value: unknown) => Promise<void>
  remove: (key: string) => Promise<void>
}

const defaultDependencies: VncUsernameStoreDependencies = {
  getCipher: getSecretCipher,
  read: (key) => getSetting<Record<string, unknown>>(key, {}),
  write: setSetting,
  remove: deleteSetting,
}

function isStoredVncUsername(value: unknown): value is StoredVncUsername {
  return isRecord(value) && value['v'] === 1 && typeof value['enc'] === 'string'
}

function targetIdentity(target: VncTarget): string {
  if (target.kind === 'ssh') return `ssh:${target.hostId}`
  if (target.kind === 'network') {
    return `network:${target.host.trim().toLowerCase().replace(/\.$/, '')}`
  }
  return 'loopback'
}

function settingKey(prefix: string, target: VncTarget): string {
  const digest = createHash('sha256').update(targetIdentity(target)).digest('hex')
  return `${prefix}${digest}`
}

function readSecret(
  prefix: string,
  target: VncTarget,
  dependencies: VncUsernameStoreDependencies,
): string | null {
  const stored = dependencies.read(settingKey(prefix, target))
  if (!isStoredVncUsername(stored) || stored.enc.length === 0) return null
  const cipher = dependencies.getCipher()
  if (!cipher) return null
  try {
    return cipher.decryptString(Buffer.from(stored.enc, 'base64'))
  } catch {
    return null
  }
}

async function rememberSecret(
  prefix: string,
  target: VncTarget,
  value: string,
  dependencies: VncUsernameStoreDependencies,
): Promise<boolean> {
  const cipher = dependencies.getCipher()
  if (!value || !cipher?.isEncryptionAvailable()) return false
  const record: StoredVncUsername = {
    v: 1,
    enc: cipher.encryptString(value).toString('base64'),
  }
  await dependencies.write(settingKey(prefix, target), record)
  return true
}

/** Return a per-machine username only when this OS user can decrypt it. */
export function getVncUsername(
  target: VncTarget,
  dependencies: VncUsernameStoreDependencies = defaultDependencies,
): string | null {
  const key = settingKey(VNC_USERNAME_SETTING_PREFIX, target)
  const stored = dependencies.read(key)
  if (!isStoredVncUsername(stored) || stored.enc.length === 0) return null
  const cipher = dependencies.getCipher()
  if (!cipher) return null
  const encrypted = Buffer.from(stored.enc, 'base64')
  let username: string
  try {
    username = cipher.decryptString(encrypted).trim()
  } catch {
    return null
  }
  if (!username || username.length > 256) return null
  migrateStoredUsername(key, cipher, encrypted, username, dependencies)
  return username
}

/**
 * Same lazy format migration as API keys (see settings.ts): a blob in a
 * read-only legacy format is rewritten through the current cipher. The read
 * that produced `username` already succeeded, so a failed rewrite costs
 * nothing but a retry on the next read.
 */
function migrateStoredUsername(
  key: string,
  cipher: SecretCipher,
  encrypted: Buffer,
  username: string,
  dependencies: VncUsernameStoreDependencies,
): void {
  if (!cipher.shouldReencrypt?.(encrypted)) return
  try {
    const record: StoredVncUsername = {
      v: 1,
      enc: (
        cipher.encryptStringForMigration?.(username) ?? cipher.encryptString(username)
      ).toString('base64'),
    }
    dependencies.write(key, record).then(() => {
      console.warn(`[vnc] migrated a stored username to the keyring cipher (${key})`)
    }, reportMigrationFailure)
    // Re-encrypting worked, so the keyring is usable right now: sweep the rest
    // instead of leaving them for a read that may never come.
    requestSecretSweep()
  } catch (error) {
    reportMigrationFailure(error)
  }
}

/**
 * Rewrite every remembered username still in a legacy format.
 *
 * Unlike the API-key sweep this cannot just re-read each secret through the
 * public getter: usernames are keyed by a one-way hash of the target, so a
 * stored key cannot be turned back into the {@link VncTarget} that getter
 * needs. It walks the stored records directly instead. A record this cipher
 * cannot open is skipped, not discarded — the same "restored on another
 * machine" case {@link getVncUsername} already tolerates.
 */
export function migrateStoredVncUsernames(
  dependencies: VncUsernameStoreDependencies = defaultDependencies,
): void {
  const cipher = dependencies.getCipher()
  if (!cipher) return
  // Top-level read: the backing store keeps `vncUsername.<hash>` as one nested
  // object, so the individual keys are not listable.
  const stored = dependencies.read(VNC_USERNAME_SETTING_ROOT)
  if (!isRecord(stored)) return
  for (const [hash, record] of Object.entries(stored)) {
    if (!isStoredVncUsername(record) || record.enc.length === 0) continue
    const encrypted = Buffer.from(record.enc, 'base64')
    let username: string
    try {
      username = cipher.decryptString(encrypted).trim()
    } catch {
      continue
    }
    if (!username || username.length > 256) continue
    migrateStoredUsername(
      `${VNC_USERNAME_SETTING_PREFIX}${hash}`,
      cipher,
      encrypted,
      username,
      dependencies,
    )
  }
}

registerSecretSweep(() => {
  migrateStoredVncUsernames()
})

function reportMigrationFailure(error: unknown): void {
  console.warn(
    '[vnc] could not migrate a stored username to the keyring cipher:',
    error instanceof Error ? error.message : error,
  )
}

/** Persist a username only when OS-backed encryption is available. */
export async function rememberVncUsername(
  target: VncTarget,
  username: string,
  dependencies: VncUsernameStoreDependencies = defaultDependencies,
): Promise<boolean> {
  const trimmed = username.trim()
  return rememberSecret(VNC_USERNAME_SETTING_PREFIX, target, trimmed, dependencies)
}

/** Return the encrypted password remembered for one VNC machine. */
export function getVncPassword(
  target: VncTarget,
  dependencies: VncUsernameStoreDependencies = defaultDependencies,
): string | null {
  const password = readSecret(VNC_PASSWORD_SETTING_PREFIX, target, dependencies)
  return password && password.length <= 4096 ? password : null
}

/** Persist a VNC password only when OS-backed encryption is available. */
export function rememberVncPassword(
  target: VncTarget,
  password: string,
  dependencies: VncUsernameStoreDependencies = defaultDependencies,
): Promise<boolean> {
  return rememberSecret(VNC_PASSWORD_SETTING_PREFIX, target, password, dependencies)
}

/** Whether this machine has a readable saved password, without exposing it. */
export function hasVncPassword(
  target: VncTarget,
  dependencies: VncUsernameStoreDependencies = defaultDependencies,
): boolean {
  return getVncPassword(target, dependencies) !== null
}

/** Remove a rejected password while preserving the still-useful username. */
export function forgetVncPassword(
  target: VncTarget,
  dependencies: VncUsernameStoreDependencies = defaultDependencies,
): Promise<void> {
  return dependencies.remove(settingKey(VNC_PASSWORD_SETTING_PREFIX, target))
}

/** Remove every remembered login field for one VNC machine. */
export async function forgetVncCredentials(
  target: VncTarget,
  dependencies: VncUsernameStoreDependencies = defaultDependencies,
): Promise<void> {
  await Promise.all([
    dependencies.remove(settingKey(VNC_USERNAME_SETTING_PREFIX, target)),
    dependencies.remove(settingKey(VNC_PASSWORD_SETTING_PREFIX, target)),
  ])
}

/** True only when new credentials can be persisted without plaintext fallback. */
export function canStoreVncCredentials(
  dependencies: VncUsernameStoreDependencies = defaultDependencies,
): boolean {
  return dependencies.getCipher()?.isEncryptionAvailable() === true
}
