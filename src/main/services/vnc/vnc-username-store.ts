import { createHash } from 'node:crypto'
import type { VncTarget } from '@shared/types/vnc.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { getSecretCipher, type SecretCipher } from '../storage/secret-cipher.ts'
import { getSetting, setSetting } from '../storage/settings.ts'

const VNC_USERNAME_SETTING_PREFIX = 'vncUsername.'

interface StoredVncUsername {
  v: 1
  enc: string
}

export interface VncUsernameStoreDependencies {
  getCipher: () => SecretCipher | null
  read: (key: string) => unknown
  write: (key: string, value: unknown) => Promise<void>
}

const defaultDependencies: VncUsernameStoreDependencies = {
  getCipher: getSecretCipher,
  read: (key) => getSetting<Record<string, unknown>>(key, {}),
  write: setSetting,
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

function settingKey(target: VncTarget): string {
  const digest = createHash('sha256').update(targetIdentity(target)).digest('hex')
  return `${VNC_USERNAME_SETTING_PREFIX}${digest}`
}

/** Return a per-machine username only when this OS user can decrypt it. */
export function getVncUsername(
  target: VncTarget,
  dependencies: VncUsernameStoreDependencies = defaultDependencies,
): string | null {
  const stored = dependencies.read(settingKey(target))
  if (!isStoredVncUsername(stored) || stored.enc.length === 0) return null
  try {
    const username = dependencies
      .getCipher()
      ?.decryptString(Buffer.from(stored.enc, 'base64'))
      .trim()
    return username && username.length <= 256 ? username : null
  } catch {
    return null
  }
}

/**
 * Persist a username only when OS-backed encryption is available. Passwords are
 * deliberately never accepted by this store.
 */
export async function rememberVncUsername(
  target: VncTarget,
  username: string,
  dependencies: VncUsernameStoreDependencies = defaultDependencies,
): Promise<boolean> {
  const trimmed = username.trim()
  const cipher = dependencies.getCipher()
  if (!trimmed || !cipher?.isEncryptionAvailable()) return false
  const record: StoredVncUsername = {
    v: 1,
    enc: cipher.encryptString(trimmed).toString('base64'),
  }
  await dependencies.write(settingKey(target), record)
  return true
}
