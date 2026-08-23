/**
 * Shell-neutral secret cipher: a random data key held by the OS keyring, and
 * AES-256-GCM over `node:crypto`. Nothing here touches Electron.
 *
 * Until now API keys were sealed by Electron's `safeStorage`, whose ciphertext
 * only Chromium's os_crypt can open. That ties every stored secret to the
 * Electron binary: a Copse shell that is not Electron (the Tauri sidecar,
 * a CLI, a test) cannot read them without re-implementing Chromium internals.
 * This cipher replaces that dependency with one the app owns: a 256-bit key
 * stored as an ordinary keyring item (Keychain / Credential Manager / Secret
 * Service — whatever the injected {@link DataKeyStore} talks to) and a
 * self-describing blob format.
 *
 * Blob layout: `MAGIC(4) ‖ IV(12) ‖ TAG(16) ‖ CIPHERTEXT`, with the magic as
 * additional authenticated data. Anything without the magic is not ours, which
 * is how {@link createMigratingCipher} tells a `safeStorage` blob apart and
 * routes it to the legacy cipher for a one-time, read-time upgrade.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { SecretCipher } from './secret-cipher.ts'

/** First bytes of every blob this cipher writes. */
export const KEYRING_CIPHER_MAGIC = Buffer.from('CPS2', 'latin1')

const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const HEADER_BYTES = KEYRING_CIPHER_MAGIC.length + IV_BYTES + TAG_BYTES

/**
 * Where the data key lives. `read` returns the stored key (base64) or `null`
 * when none has been created yet, and throws when the keyring itself cannot be
 * reached — a locked Linux keyring, no D-Bus session, a denied Keychain ACL.
 */
export interface DataKeyStore {
  read(): string | null
  write(value: string): void
}

export interface KeyringCipherOptions {
  /** How long a failed keyring probe is remembered before retrying (ms). */
  unavailableRetryMs?: number
  now?: () => number
}

/** Whether `encrypted` was produced by {@link createKeyringCipher}. */
export function isKeyringCipherBlob(encrypted: Uint8Array): boolean {
  return (
    encrypted.length >= HEADER_BYTES &&
    Buffer.from(encrypted.buffer, encrypted.byteOffset, KEYRING_CIPHER_MAGIC.length).equals(
      KEYRING_CIPHER_MAGIC,
    )
  )
}

export function createKeyringCipher(
  store: DataKeyStore,
  options: KeyringCipherOptions = {},
): SecretCipher {
  const retryMs = options.unavailableRetryMs ?? 30_000
  const now = options.now ?? Date.now
  // The key never changes once created, so one successful read is sticky. A
  // failed probe is remembered briefly: availability is consulted on render
  // paths, and a Secret Service round-trip per call would be far too slow —
  // but a keyring that unlocks a minute later must become usable without a
  // restart, so the negative verdict expires.
  let key: Buffer | null = null
  let unavailableUntil = 0

  function loadKey(create: boolean): Buffer | null {
    if (key) return key
    const stored = store.read()
    if (stored !== null) {
      const bytes = Buffer.from(stored, 'base64')
      if (bytes.length !== KEY_BYTES) throw new Error('stored data key has the wrong length')
      key = bytes
      return key
    }
    if (!create) return null
    const fresh = randomBytes(KEY_BYTES)
    store.write(fresh.toString('base64'))
    key = fresh
    return key
  }

  return {
    isEncryptionAvailable(): boolean {
      if (key) return true
      if (now() < unavailableUntil) return false
      try {
        // Reachability is what matters; a missing key is created on first write.
        store.read()
        return true
      } catch {
        unavailableUntil = now() + retryMs
        return false
      }
    },
    encryptString(plainText: string): Buffer {
      const dataKey = loadKey(true)
      if (!dataKey) throw new Error('no data key')
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', dataKey, iv)
      cipher.setAAD(KEYRING_CIPHER_MAGIC)
      const body = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
      return Buffer.concat([KEYRING_CIPHER_MAGIC, iv, cipher.getAuthTag(), body])
    },
    decryptString(encrypted: Buffer): string {
      if (!isKeyringCipherBlob(encrypted)) throw new Error('not a keyring-cipher blob')
      const dataKey = loadKey(false)
      if (!dataKey) throw new Error('no data key in the keyring')
      let offset = KEYRING_CIPHER_MAGIC.length
      const iv = encrypted.subarray(offset, (offset += IV_BYTES))
      const tag = encrypted.subarray(offset, (offset += TAG_BYTES))
      const decipher = createDecipheriv('aes-256-gcm', dataKey, iv)
      decipher.setAAD(KEYRING_CIPHER_MAGIC)
      decipher.setAuthTag(tag)
      return Buffer.concat([
        decipher.update(encrypted.subarray(offset)),
        decipher.final(),
      ]).toString('utf8')
    },
    shouldReencrypt(encrypted: Buffer): boolean {
      return !isKeyringCipherBlob(encrypted)
    },
  }
}

/**
 * The cipher the app installs: writes always go to `primary`; reads are
 * routed by blob format, so secrets sealed by the legacy cipher (Electron's
 * `safeStorage`) keep opening for as long as the legacy cipher is around.
 * `shouldReencrypt` tells callers when a successfully read blob belongs to the
 * legacy format and the primary is ready to take it — that is the migration,
 * performed lazily by whoever reads the secret.
 *
 * With no legacy cipher (any shell that is not Electron), legacy blobs are
 * simply unreadable, which the settings code already treats as "re-enter the
 * key" — the same outcome as restoring a profile on another machine.
 */
export function createMigratingCipher(
  primary: SecretCipher,
  legacy: SecretCipher | null,
): SecretCipher {
  return {
    isEncryptionAvailable(): boolean {
      return primary.isEncryptionAvailable() || (legacy?.isEncryptionAvailable() ?? false)
    },
    encryptString(plainText: string): Buffer {
      if (primary.isEncryptionAvailable()) return primary.encryptString(plainText)
      if (legacy?.isEncryptionAvailable()) return legacy.encryptString(plainText)
      throw new Error('no secret cipher is available')
    },
    decryptString(encrypted: Buffer): string {
      if (isKeyringCipherBlob(encrypted)) return primary.decryptString(encrypted)
      if (!legacy) throw new Error('legacy secret format with no legacy cipher installed')
      return legacy.decryptString(encrypted)
    },
    shouldReencrypt(encrypted: Buffer): boolean {
      return !isKeyringCipherBlob(encrypted) && primary.isEncryptionAvailable()
    },
  }
}
