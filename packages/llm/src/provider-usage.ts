import type { ModelUsage } from './wire-types.ts'

/** Some providers track the token usage of their most recent stream call. */
export interface ProviderWithUsage {
  lastUsage: ModelUsage | null
}

/**
 * Narrow a provider to one that reports its most recent usage.
 *
 * `lastUsage` is an optional part of the provider contract — the SDK-backed
 * adapters keep it, the mocks and wrappers may not — so every caller that wants
 * a token count off a provider has to ask first. A predicate rather than an
 * `as` cast: the value is whatever a provider factory returned.
 */
export function hasLastUsage(p: unknown): p is ProviderWithUsage {
  return typeof p === 'object' && p !== null && 'lastUsage' in p
}
