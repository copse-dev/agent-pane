/** Some providers track the token usage of their most recent stream call. */
export interface ProviderWithUsage {
  lastUsage: { inputTokens: number; outputTokens: number } | null
}

export function hasLastUsage(p: unknown): p is ProviderWithUsage {
  return typeof p === 'object' && p !== null && 'lastUsage' in p
}
