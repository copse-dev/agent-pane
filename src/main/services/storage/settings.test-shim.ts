import { resolveLmStudioApiKey } from '@shared/lm-studio-api-key.ts'
import { firstNonEmptyString, matchesFallbackType } from '@shared/unknown-value.ts'
import { getSettingSchema } from './settings-schema.ts'
import { getExplicitSettingsProfile } from './settings-context.ts'

const settings = new Map<string, unknown>()
const apiKeys = new Map<string, string>()

function schemaAccepts<T>(
  schema: NonNullable<ReturnType<typeof getSettingSchema>>,
  value: unknown,
  _fallback: T,
): value is T {
  return schema.safeParse(value).success
}

export type KeyProvider = string

export type CloudKeyProvider = string

const ENV_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  cursor: 'CURSOR_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  parallel: 'PARALLEL_API_KEY',
  groq: 'GROQ_API_KEY',
  together: 'TOGETHER_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  gemini: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
}

export function getApiKey(provider: KeyProvider): string | null {
  const scoped = getExplicitSettingsProfile()
  if (scoped) return firstNonEmptyString(scoped.apiKeys?.[provider]) ?? null
  return apiKeys.get(provider) ?? null
}

export function hasApiKey(provider: KeyProvider): boolean {
  const scoped = getExplicitSettingsProfile()
  if (scoped) return (scoped.apiKeys?.[provider]?.trim().length ?? 0) > 0
  return apiKeys.has(provider)
}

export function setApiKey(provider: KeyProvider, key: string): void {
  if (getExplicitSettingsProfile()) {
    throw new Error('Cannot mutate API keys inside an explicit settings profile.')
  }
  apiKeys.set(provider, key.trim())
}

export function deleteApiKey(provider: KeyProvider): void {
  if (getExplicitSettingsProfile()) {
    throw new Error('Cannot mutate API keys inside an explicit settings profile.')
  }
  apiKeys.delete(provider)
}

export function isProviderAvailable(provider: CloudKeyProvider): boolean {
  if (getExplicitSettingsProfile()) return hasApiKey(provider)
  const envVar = ENV_VARS[provider]
  const environmentKey = envVar ? firstNonEmptyString(process.env[envVar]) : undefined
  return environmentKey !== undefined || hasApiKey(provider)
}

export function isApiKeyEncrypted(provider: KeyProvider): boolean | null {
  return apiKeys.has(provider) ? true : null
}

export function isApiKeyReadable(provider: KeyProvider): boolean | null {
  if (!hasApiKey(provider)) return null
  return getApiKey(provider) !== null
}

export function resolveApiKey(provider: KeyProvider): string | null {
  const scoped = getExplicitSettingsProfile()
  if (scoped) return firstNonEmptyString(scoped.apiKeys?.[provider]) ?? null
  const stored = getApiKey(provider)
  if (stored) return stored
  const envVar = ENV_VARS[provider]
  return envVar ? (firstNonEmptyString(process.env[envVar]) ?? null) : null
}

export function getLmStudioApiKey(): string {
  const scoped = getExplicitSettingsProfile()
  if (scoped) return firstNonEmptyString(scoped.apiKeys?.['lmstudio']) ?? ''
  return resolveLmStudioApiKey(getApiKey('lmstudio'), process.env)
}

export function getSetting<T>(key: string, fallback: T): T {
  const scoped = getExplicitSettingsProfile()
  const value = scoped ? scoped.values[key] : settings.get(key)
  const schema = getSettingSchema(key)
  if (schema) {
    return schemaAccepts(schema, value, fallback) ? value : fallback
  }
  return matchesFallbackType(value, fallback) ? value : fallback
}

export function getSettingTrimmed(key: string, fallback = ''): string {
  return getSetting<string>(key, fallback).trim()
}

export function setSetting(key: string, value: unknown): Promise<void> {
  if (getExplicitSettingsProfile()) {
    return Promise.reject(new Error('Cannot mutate settings inside an explicit settings profile.'))
  }
  settings.set(key, value)
  return Promise.resolve()
}
