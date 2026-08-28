/**
 * Persistent SSH secrets, encrypted by the app's OS-keyring-backed cipher.
 *
 * Records are scoped to a configured host id and keyed by a hash of OpenSSH's
 * prompt. The prompt itself can contain a username, hostname, or identity-file
 * path, so keeping only its digest avoids adding that metadata to the store.
 * Plaintext persistence is deliberately unsupported: when the keyring is not
 * available, the session cache remains the only remember option.
 */
import { createHash } from 'node:crypto'
import { isRecord } from '@shared/unknown-value.ts'
import { getSecretCipher, isSecretEncryptionAvailable } from '../storage/secret-cipher.ts'
import { openPersistentStore } from '../storage/persistent-store.ts'

interface StoredCredential {
  v: 1
  enc: string
}

const store = openPersistentStore({ name: 'ssh-credentials' })
const HOSTS_KEY = 'hosts'

function promptKey(prompt: string): string {
  return createHash('sha256').update(prompt.trim()).digest('hex')
}

function parseCredentials(raw: unknown): Map<string, StoredCredential> {
  if (!isRecord(raw)) return new Map()
  const credentials = new Map<string, StoredCredential>()
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value) || value['v'] !== 1 || typeof value['enc'] !== 'string') continue
    credentials.set(key, { v: 1, enc: value['enc'] })
  }
  return credentials
}

function readHosts(): Map<string, Map<string, StoredCredential>> {
  const raw = store.get(HOSTS_KEY)
  if (!isRecord(raw)) return new Map()
  const hosts = new Map<string, Map<string, StoredCredential>>()
  for (const [hostId, value] of Object.entries(raw)) {
    const credentials = parseCredentials(value)
    if (credentials.size > 0) hosts.set(hostId, credentials)
  }
  return hosts
}

function readCredentials(hostId: string): Map<string, StoredCredential> {
  return readHosts().get(hostId) ?? new Map<string, StoredCredential>()
}

function writeCredentials(hostId: string, credentials: Map<string, StoredCredential>): void {
  const hosts = readHosts()
  if (credentials.size === 0) {
    hosts.delete(hostId)
  } else {
    hosts.set(hostId, credentials)
  }
  if (hosts.size === 0) {
    store.delete(HOSTS_KEY)
  } else {
    store.set(
      HOSTS_KEY,
      Object.fromEntries([...hosts].map(([id, entries]) => [id, Object.fromEntries(entries)])),
    )
  }
}

/** True when a new SSH secret can be persisted without writing plaintext. */
export function canStoreSshCredentials(): boolean {
  return isSecretEncryptionAvailable()
}

/** Read one remembered secret. Unreadable/corrupt records fail closed. */
export function getStoredSshCredential(hostId: string, prompt: string): string | null {
  const record = readCredentials(hostId).get(promptKey(prompt))
  const cipher = getSecretCipher()
  if (!record || !cipher) return null
  try {
    return cipher.decryptString(Buffer.from(record.enc, 'base64'))
  } catch {
    return null
  }
}

/**
 * Encrypt and persist one secret. Returns false when secure storage is not
 * available; callers may still retain the answer in their in-memory cache.
 */
export function setStoredSshCredential(hostId: string, prompt: string, value: string): boolean {
  const cipher = getSecretCipher()
  if (!value || !cipher || !canStoreSshCredentials()) return false
  try {
    const credentials = readCredentials(hostId)
    credentials.set(promptKey(prompt), {
      v: 1,
      enc: cipher.encryptString(value).toString('base64'),
    })
    writeCredentials(hostId, credentials)
    return true
  } catch {
    return false
  }
}

/** Remove the one secret OpenSSH has just rejected. */
export function deleteStoredSshCredential(hostId: string, prompt: string): void {
  const credentials = readCredentials(hostId)
  if (!credentials.delete(promptKey(prompt))) return
  writeCredentials(hostId, credentials)
}

/** Remove every remembered secret belonging to a configured connection. */
export function deleteStoredSshCredentials(hostId: string): void {
  writeCredentials(hostId, new Map())
}

/** Host ids with at least one stored authentication answer; no secret leaves main. */
export function listStoredSshCredentialHostIds(): string[] {
  return [...readHosts().keys()]
}
