const settings = new Map<string, unknown>()
const apiKeys = new Map<string, string>()

export type KeyProvider = 'anthropic' | 'openai' | 'lmstudio'

export function getApiKey(provider: KeyProvider): string | null {
  return apiKeys.get(provider) ?? null
}

export function setApiKey(provider: KeyProvider, key: string): void {
  apiKeys.set(provider, key.trim())
}

export function isProviderAvailable(_provider: 'anthropic' | 'openai'): boolean {
  return false
}

export function getSetting<T>(key: string, fallback: T): T {
  return (settings.get(key) as T | undefined) ?? fallback
}

export function setSetting(key: string, value: unknown): void {
  settings.set(key, value)
}
