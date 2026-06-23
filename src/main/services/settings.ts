import { safeStorage } from 'electron'
import ElectronStore from 'electron-store'
import { resolveLmStudioApiKey } from '@shared/lm-studio-api-key.ts'
import { runSerialized } from './write-queue.ts'
import { getSettingSchema } from './settings-schema.ts'

const store = new ElectronStore<Record<string, unknown>>({ name: 'settings' })

// Distinct write-queue namespace so settings keys can't collide with the shared
// electron-store keys serialized elsewhere.
const queueKey = (key: string) => `settings:${key}`

interface StoredKey {
  v: 1
  enc: string // base64 of the encrypted (or, if unavailable, plain) bytes
  plain?: boolean
}

export type KeyProvider = 'anthropic' | 'openai' | 'lmstudio' | 'cursor'

export function hasApiKey(provider: KeyProvider): boolean {
  const raw = store.get(`apiKey.${provider}`) as StoredKey | undefined
  return !!raw && typeof raw === 'object' && typeof raw.enc === 'string' && raw.enc.length > 0
}

export function getApiKey(provider: KeyProvider): string | null {
  // electron-store JSON-serializes values, so a raw Buffer cannot round-trip.
  // We persist a base64 string instead. (Old Buffer-shaped records are ignored.)
  const raw = store.get(`apiKey.${provider}`) as StoredKey | undefined
  if (!raw || typeof raw !== 'object' || !raw.enc) return null
  try {
    const buf = Buffer.from(raw.enc, 'base64')
    return raw.plain ? buf.toString('utf8') : safeStorage.decryptString(buf)
  } catch {
    return null
  }
}

function envVarFor(
  provider: KeyProvider,
): 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' | 'CURSOR_API_KEY' | null {
  if (provider === 'anthropic') return 'ANTHROPIC_API_KEY'
  if (provider === 'openai') return 'OPENAI_API_KEY'
  if (provider === 'cursor') return 'CURSOR_API_KEY'
  return null
}

export function setApiKey(provider: KeyProvider, key: string): void {
  const trimmed = key.trim()
  // An empty/whitespace value clears the key rather than persisting a blank one
  // and stomping the current session's env var with an empty string.
  if (!trimmed) {
    deleteApiKey(provider)
    return
  }

  // Reflect cloud keys into the environment so the current session uses them
  // even if persistence fails. LM Studio is read from storage on demand, so it
  // needs no env var.
  const envVar = envVarFor(provider)
  if (envVar) process.env[envVar] = trimmed

  const available = safeStorage.isEncryptionAvailable()
  if (!available) {
    console.warn(
      `[copse-panel] OS secure storage is unavailable; the ${provider} API key will be stored as base64 plaintext in settings.json. Install/unlock a system keyring (e.g. gnome-keyring / libsecret on Linux) to encrypt it at rest.`,
    )
  }
  const bytes = available ? safeStorage.encryptString(trimmed) : Buffer.from(trimmed, 'utf8')
  const record: StoredKey = { v: 1, enc: bytes.toString('base64'), plain: !available }
  store.set(`apiKey.${provider}`, record)
}

/** Remove a stored API key and clear the corresponding session env var. */
export function deleteApiKey(provider: KeyProvider): void {
  store.delete(`apiKey.${provider}`)
  const envVar = envVarFor(provider)
  if (envVar) delete process.env[envVar]
}

/**
 * Whether the stored key for a provider is OS-encrypted (`true`) vs persisted as
 * base64 plaintext (`false`). Returns `null` when no key is stored. Lets the UI
 * warn the user that an unencrypted key is at rest.
 */
export function isApiKeyEncrypted(provider: KeyProvider): boolean | null {
  const raw = store.get(`apiKey.${provider}`) as StoredKey | undefined
  if (!raw || typeof raw !== 'object' || typeof raw.enc !== 'string' || raw.enc.length === 0) {
    return null
  }
  return raw.plain !== true
}

// Whether a cloud provider can be used at all — a key is stored in Settings or
// present in the environment.
export function isProviderAvailable(provider: 'anthropic' | 'openai' | 'cursor'): boolean {
  if (provider === 'anthropic') return !!(process.env.ANTHROPIC_API_KEY || hasApiKey('anthropic'))
  if (provider === 'cursor') return !!(process.env.CURSOR_API_KEY || hasApiKey('cursor'))
  return !!(process.env.OPENAI_API_KEY || hasApiKey('openai'))
}

export function getLmStudioApiKey(): string {
  return resolveLmStudioApiKey(getApiKey('lmstudio'), process.env)
}

export function getSetting<T>(key: string, fallback: T): T {
  const raw = store.get(key)
  if (raw === undefined || raw === null) return fallback
  // If we have a schema for this key, validate on read so a corrupt/wrong-typed
  // persisted value degrades to the fallback instead of being trusted blindly.
  const schema = getSettingSchema(key)
  if (schema) {
    const result = schema.safeParse(raw)
    return result.success ? (result.data as T) : fallback
  }
  return raw as T
}

/** Read a string setting and trim it (empty string when unset/blank). */
export function getSettingTrimmed(key: string, fallback = ''): string {
  return getSetting<string>(key, fallback).trim()
}

/**
 * Persist a setting. Writes are serialized per key (electron-store's file write
 * is non-atomic, so concurrent writers could otherwise drop an update). When the
 * key has a registered schema, the value is validated first and a bad value is
 * rejected rather than silently corrupting the store.
 */
export function setSetting(key: string, value: unknown): Promise<void> {
  const schema = getSettingSchema(key)
  const toStore = schema ? schema.parse(value) : value
  return runSerialized(queueKey(key), () => {
    store.set(key, toStore)
  })
}
