import { resolveLmStudioApiKey } from '@shared/lm-studio-api-key.ts'

const settings = new Map<string, unknown>()
const apiKeys = new Map<string, string>()

export type KeyProvider =
  | 'anthropic'
  | 'openai'
  | 'lmstudio'
  | 'cursor'
  | 'openrouter'
  | 'mistral'
  | 'gemini'
  | 'deepseek'

export type CloudKeyProvider = Exclude<KeyProvider, 'lmstudio'>

const ENV_VARS: Partial<Record<KeyProvider, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  cursor: 'CURSOR_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  gemini: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
}

export function getApiKey(provider: KeyProvider): string | null {
  return apiKeys.get(provider) ?? null
}

export function hasApiKey(provider: KeyProvider): boolean {
  return apiKeys.has(provider)
}

export function setApiKey(provider: KeyProvider, key: string): void {
  apiKeys.set(provider, key.trim())
}

export function isProviderAvailable(provider: CloudKeyProvider): boolean {
  const envVar = ENV_VARS[provider]
  return !!((envVar && process.env[envVar]) || hasApiKey(provider))
}

export function getLmStudioApiKey(): string {
  return resolveLmStudioApiKey(getApiKey('lmstudio'), process.env)
}

export function getSetting<T>(key: string, fallback: T): T {
  return (settings.get(key) as T | undefined) ?? fallback
}

export function getSettingTrimmed(key: string, fallback = ''): string {
  return getSetting<string>(key, fallback).trim()
}

export function setSetting(key: string, value: unknown): Promise<void> {
  settings.set(key, value)
  return Promise.resolve()
}
