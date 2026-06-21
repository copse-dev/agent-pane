import { resolveLmStudioApiKey } from '@shared/lm-studio-api-key.ts'

const settings = new Map<string, unknown>()
const apiKeys = new Map<string, string>()

export type KeyProvider = 'anthropic' | 'openai' | 'lmstudio'

export function getApiKey(provider: KeyProvider): string | null {
  return apiKeys.get(provider) ?? null
}

export function hasApiKey(provider: KeyProvider): boolean {
  return apiKeys.has(provider)
}

export function setApiKey(provider: KeyProvider, key: string): void {
  apiKeys.set(provider, key.trim())
}

export function isProviderAvailable(provider: 'anthropic' | 'openai'): boolean {
  if (provider === 'anthropic') return !!(process.env.ANTHROPIC_API_KEY || hasApiKey('anthropic'))
  return !!(process.env.OPENAI_API_KEY || hasApiKey('openai'))
}

export function getLmStudioApiKey(): string {
  return resolveLmStudioApiKey(getApiKey('lmstudio'), process.env)
}

export function getSetting<T>(key: string, fallback: T): T {
  return (settings.get(key) as T | undefined) ?? fallback
}

export function setSetting(key: string, value: unknown): Promise<void> {
  settings.set(key, value)
  return Promise.resolve()
}
