import { getSecretCipher, isSecretEncryptionAvailable } from './secret-cipher.ts'
import { resolveLmStudioApiKey } from '@shared/lm-studio-api-key.ts'
import { BUILTIN_EXTRA_PROVIDERS } from '@copse/llm/extra-providers.ts'
import { openPersistentStore } from './persistent-store.ts'
import { runSerialized } from './write-queue.ts'
import { getSettingSchema } from './settings-schema.ts'
import {
  expectString,
  firstNonEmptyString,
  isRecord,
  matchesFallbackType,
} from '@shared/unknown-value.ts'
import { getExplicitSettingsProfile } from './settings-context.ts'

// Cache reads in memory so electron-store does not re-read and re-parse the
// whole settings.json file on every getSetting/hasApiKey/getApiKey call. All
// settings writes in this process go through this module, including encrypted
// API-key records, so the write-through cache stays coherent.
//
// Known limitation (same as config storage): a separate process that shares
// settings.json has its own persistent-store instance; this cache will not
// observe another process's write to a key it has already read. In-process
// writers stay coherent via write-through + the per-key write queue.
const cached = openPersistentStore({ name: 'settings' })

// Distinct write-queue namespace so settings keys can't collide with the shared
// electron-store keys serialized elsewhere.
const queueKey = (key: string): string => `settings:${key}`

interface StoredKey {
  v: 1
  enc: string // base64 of the encrypted (or, if unavailable, plain) bytes
  plain?: boolean
}

function isStoredKey(value: unknown): value is StoredKey {
  return (
    isRecord(value) &&
    value['v'] === 1 &&
    typeof value['enc'] === 'string' &&
    (value['plain'] === undefined || typeof value['plain'] === 'boolean')
  )
}

function schemaAccepts<T>(
  schema: NonNullable<ReturnType<typeof getSettingSchema>>,
  value: unknown,
  _fallback: T,
): value is T {
  return schema.safeParse(value).success
}

// A key is stored per provider slug at `apiKey.<slug>`. The fixed cloud providers
// and shipped presets keep an env-var fallback; user-added custom providers (any
// other slug) are stored-only, like the local LM Studio key.
export type KeyProvider = string

/** Cloud providers whose availability/keys are backed by an env var fallback. */
export type CloudKeyProvider = string

const FIXED_PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  cursor: 'CURSOR_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  parallel: 'PARALLEL_API_KEY',
  // GitHub token for the Claude Cloud Agent's github_repository resource (clone +
  // push + PR). Not a model provider — stored like an API key, env fallback below.
  github: 'GITHUB_TOKEN',
}

// Env-var fallback for every provider that ships one: the fixed cloud providers
// plus the built-in OpenAI-compatible presets (Mistral/Gemini/DeepSeek).
const PROVIDER_ENV_VARS: Record<string, string> = {
  ...FIXED_PROVIDER_ENV_VARS,
  ...Object.fromEntries(
    BUILTIN_EXTRA_PROVIDERS.filter((p) => p.envVar).map((p) => [p.id, expectString(p.envVar)]),
  ),
}

export function hasApiKey(provider: KeyProvider): boolean {
  const scoped = getExplicitSettingsProfile()
  if (scoped) return (scoped.apiKeys?.[provider]?.trim().length ?? 0) > 0
  const raw = cached.get(`apiKey.${provider}`)
  return isStoredKey(raw) && raw.enc.length > 0
}

export function getApiKey(provider: KeyProvider): string | null {
  const scoped = getExplicitSettingsProfile()
  if (scoped) return firstNonEmptyString(scoped.apiKeys?.[provider]) ?? null
  // electron-store JSON-serializes values, so a raw Buffer cannot round-trip.
  // We persist a base64 string instead. (Old Buffer-shaped records are ignored.)
  const raw = cached.get(`apiKey.${provider}`)
  if (!isStoredKey(raw) || !raw.enc) return null
  try {
    const buf = Buffer.from(raw.enc, 'base64')
    if (raw.plain) return buf.toString('utf8')
    // No cipher installed: an encrypted key cannot be read here.
    return getSecretCipher()?.decryptString(buf) ?? null
  } catch {
    return null
  }
}

/**
 * Whether a stored key can actually be decrypted on this machine.
 *
 * `safeStorage` binds ciphertext to the OS user's keychain (Keychain, DPAPI, or
 * the Linux secret service) — never to the profile directory. Restoring a
 * profile on another machine, or under a different OS user, therefore keeps a
 * key that {@link hasApiKey} reports as present and {@link getApiKey} cannot
 * read, so every request fails while the settings UI shows a key on file. Returns
 * `null` when no key is stored.
 */
export function isApiKeyReadable(provider: KeyProvider): boolean | null {
  if (!hasApiKey(provider)) return null
  return getApiKey(provider) !== null
}

function envVarFor(provider: KeyProvider): string | null {
  return PROVIDER_ENV_VARS[provider] ?? null
}

/**
 * Outcome of {@link setApiKey}. `plaintext-consent-required` means OS secure
 * storage is unavailable and the caller has not explicitly approved storing this
 * key unencrypted, so nothing was written — the caller must obtain consent and
 * retry with `{ allowPlaintext: true }`.
 */
export type SetApiKeyResult = { ok: true } | { ok: false; reason: 'plaintext-consent-required' }

export function setApiKey(
  provider: KeyProvider,
  key: string,
  opts: { allowPlaintext?: boolean } = {},
): SetApiKeyResult {
  if (getExplicitSettingsProfile()) {
    throw new Error('Cannot mutate API keys inside an explicit settings profile.')
  }
  const trimmed = key.trim()
  // An empty/whitespace value clears the key rather than persisting a blank one
  // and stomping the current session's env var with an empty string.
  if (!trimmed) {
    deleteApiKey(provider)
    return { ok: true }
  }

  const available = isSecretEncryptionAvailable()
  // Encryption unavailable and no explicit per-key consent to store plaintext:
  // refuse to persist rather than silently writing the key to disk in the clear.
  // The caller (IPC → renderer) surfaces a confirmation and retries with
  // `allowPlaintext: true` once the user approves storing this key unencrypted.
  if (!available && opts.allowPlaintext !== true) {
    return { ok: false, reason: 'plaintext-consent-required' }
  }

  // Reflect cloud keys into the environment so the current session uses them
  // even if persistence fails. LM Studio is read from storage on demand, so it
  // needs no env var. Done only once we're committing to store the key, so a
  // declined plaintext key leaks into neither the environment nor disk.
  const envVar = envVarFor(provider)
  if (envVar) process.env[envVar] = trimmed

  if (!available) {
    console.warn(
      `[copse-panel] OS secure storage is unavailable; the ${provider} API key will be stored as base64 plaintext in settings.json (with explicit consent). Install and unlock a system keyring to encrypt it at rest.`,
    )
  }
  const bytes = available
    ? (getSecretCipher()?.encryptString(trimmed) ?? Buffer.from(trimmed, 'utf8'))
    : Buffer.from(trimmed, 'utf8')
  const record: StoredKey = { v: 1, enc: bytes.toString('base64'), plain: !available }
  cached.set(`apiKey.${provider}`, record)
  return { ok: true }
}

/** Remove a stored API key and clear the corresponding session env var. */
export function deleteApiKey(provider: KeyProvider): void {
  if (getExplicitSettingsProfile()) {
    throw new Error('Cannot mutate API keys inside an explicit settings profile.')
  }
  cached.delete(`apiKey.${provider}`)
  const envVar = envVarFor(provider)
  if (envVar) Reflect.deleteProperty(process.env, envVar)
}

/**
 * Whether the stored key for a provider is OS-encrypted (`true`) vs persisted as
 * base64 plaintext (`false`). Returns `null` when no key is stored.
 *
 * Surfaced to the renderer over the `settings:getKeyEncrypted` IPC channel so the
 * Settings UI can show a per-provider at-rest badge (and warn on the plaintext
 * fallback), alongside the `console.warn` emitted in `setApiKey` and the README's
 * "How API keys are stored" section.
 */
export function isApiKeyEncrypted(provider: KeyProvider): boolean | null {
  if (getExplicitSettingsProfile()) return null
  const raw = cached.get(`apiKey.${provider}`)
  if (!isStoredKey(raw) || raw.enc.length === 0) {
    return null
  }
  return raw.plain !== true
}

// Whether a cloud provider can be used at all — a key is stored in Settings or
// present in the environment.
export function isProviderAvailable(provider: CloudKeyProvider): boolean {
  if (getExplicitSettingsProfile()) return hasApiKey(provider)
  const envVar = envVarFor(provider)
  const environmentKey = envVar ? firstNonEmptyString(process.env[envVar]) : undefined
  return environmentKey !== undefined || hasApiKey(provider)
}

/** Stored key, falling back to the provider's env var when it ships one. */
export function resolveApiKey(provider: KeyProvider): string | null {
  const scoped = getExplicitSettingsProfile()
  if (scoped) return firstNonEmptyString(scoped.apiKeys?.[provider]) ?? null
  const stored = getApiKey(provider)
  if (stored) return stored
  const envVar = envVarFor(provider)
  return envVar ? (firstNonEmptyString(process.env[envVar]) ?? null) : null
}

export function getLmStudioApiKey(): string {
  const scoped = getExplicitSettingsProfile()
  if (scoped) return firstNonEmptyString(scoped.apiKeys?.['lmstudio']) ?? ''
  return resolveLmStudioApiKey(getApiKey('lmstudio'), process.env)
}

export function getSetting<T>(key: string, fallback: T): T {
  const scoped = getExplicitSettingsProfile()
  const raw = scoped ? scoped.values[key] : cached.get(key)
  if (raw === undefined || raw === null) return fallback
  // If we have a schema for this key, validate on read so a corrupt/wrong-typed
  // persisted value degrades to the fallback instead of being trusted blindly.
  const schema = getSettingSchema(key)
  if (schema) {
    return schemaAccepts(schema, raw, fallback) ? raw : fallback
  }
  return matchesFallbackType(raw, fallback) ? raw : fallback
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
  if (getExplicitSettingsProfile()) {
    return Promise.reject(new Error('Cannot mutate settings inside an explicit settings profile.'))
  }
  const schema = getSettingSchema(key)
  const toStore = schema ? schema.parse(value) : value
  return runSerialized(queueKey(key), () => {
    cached.set(key, toStore)
  })
}
