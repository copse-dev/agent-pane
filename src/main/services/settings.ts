import { safeStorage } from 'electron'
import ElectronStore from 'electron-store'

const store = new ElectronStore({ name: 'settings' })

interface StoredKey {
  v: 1
  enc: string // base64 of the encrypted (or, if unavailable, plain) bytes
  plain?: boolean
}

export type KeyProvider = 'anthropic' | 'openai' | 'lmstudio'

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

export function setApiKey(provider: KeyProvider, key: string): void {
  const trimmed = key.trim()
  // Reflect cloud keys into the environment so the current session uses them
  // even if persistence fails. LM Studio is read from storage on demand, so it
  // needs no env var.
  if (provider === 'anthropic') process.env.ANTHROPIC_API_KEY = trimmed
  else if (provider === 'openai') process.env.OPENAI_API_KEY = trimmed

  const available = safeStorage.isEncryptionAvailable()
  const bytes = available
    ? safeStorage.encryptString(trimmed)
    : Buffer.from(trimmed, 'utf8')
  const record: StoredKey = { v: 1, enc: bytes.toString('base64'), plain: !available }
  store.set(`apiKey.${provider}`, record)
}

// Whether a cloud provider can be used at all — a key is stored in Settings or
// present in the environment.
export function isProviderAvailable(provider: 'anthropic' | 'openai'): boolean {
  if (provider === 'anthropic') return !!(getApiKey('anthropic') || process.env.ANTHROPIC_API_KEY)
  return !!(getApiKey('openai') || process.env.OPENAI_API_KEY)
}

export function getSetting<T>(key: string, fallback: T): T {
  return (store.get(key) as T | undefined) ?? fallback
}

export function setSetting(key: string, value: unknown): void {
  store.set(key, value as any)
}
