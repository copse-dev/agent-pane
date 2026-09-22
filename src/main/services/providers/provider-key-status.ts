import { validateApiKey } from './validate-api-key.ts'
import { resolveApiKey } from '../storage/settings.ts'
import { AsyncTtlCache } from '../async-ttl-cache.ts'

/** How long a successful key validation is reused before re-checking. */
const VALIDATION_TTL_MS = 5 * 60 * 1000

/** Failed validations retry sooner so a fixed key surfaces quickly. */
const VALIDATION_FAILURE_TTL_MS = 30 * 1000

const validationCache = new AsyncTtlCache<string, boolean>({
  ttlMs: (ok): number => (ok ? VALIDATION_TTL_MS : VALIDATION_FAILURE_TTL_MS),
  maxEntries: 32,
})
const activeCacheKeys = new Map<string, string>()

function selectCacheKey(provider: string, key: string): string {
  const cacheKey = JSON.stringify([provider, key])
  const previous = activeCacheKeys.get(provider)
  if (previous && previous !== cacheKey) validationCache.invalidate(previous)
  activeCacheKeys.set(provider, cacheKey)
  return cacheKey
}

export function invalidateProviderKeyStatus(provider: string): void {
  const cacheKey = activeCacheKeys.get(provider)
  if (cacheKey) validationCache.invalidate(cacheKey)
  activeCacheKeys.delete(provider)
}

/** Seed the cache after an explicit validateKey call from Settings. */
export function recordProviderKeyValidation(provider: string, key: string, ok: boolean): void {
  validationCache.set(selectCacheKey(provider, key.trim()), ok)
}

export function clearProviderKeyStatusCache(): void {
  validationCache.clear()
  activeCacheKeys.clear()
}

/**
 * Whether a provider has a stored/env key that passed the last validation check.
 * Absent or blank keys are unavailable; a present but rejected key is too.
 */
export async function isProviderKeyUsable(provider: string): Promise<boolean> {
  const key = resolveApiKey(provider)?.trim()
  if (!key) return false
  const cacheKey = selectCacheKey(provider, key)

  return validationCache.get(cacheKey, async () => {
    const result = await validateApiKey(provider, key)
    return result.ok
  })
}
