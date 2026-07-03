import { validateApiKey } from './validate-api-key.ts'
import { resolveApiKey } from './settings.ts'

interface CachedValidation {
  ok: boolean
  expiresAt: number
}

/** How long a successful key validation is reused before re-checking. */
const VALIDATION_TTL_MS = 5 * 60 * 1000

/** Failed validations retry sooner so a fixed key surfaces quickly. */
const VALIDATION_FAILURE_TTL_MS = 30 * 1000

const validationCache = new Map<string, CachedValidation>()

export function invalidateProviderKeyStatus(provider: string): void {
  validationCache.delete(provider)
}

/** Seed the cache after an explicit validateKey call from Settings. */
export function recordProviderKeyValidation(provider: string, ok: boolean): void {
  validationCache.set(provider, {
    ok,
    expiresAt: Date.now() + (ok ? VALIDATION_TTL_MS : VALIDATION_FAILURE_TTL_MS),
  })
}

export function clearProviderKeyStatusCache(): void {
  validationCache.clear()
}

/**
 * Whether a provider has a stored/env key that passed the last validation check.
 * Absent or blank keys are unavailable; a present but rejected key is too.
 */
export async function isProviderKeyUsable(provider: string): Promise<boolean> {
  const key = resolveApiKey(provider)
  if (!key?.trim()) return false

  const cached = validationCache.get(provider)
  if (cached && cached.expiresAt > Date.now()) return cached.ok

  const result = await validateApiKey(provider, key)
  validationCache.set(provider, {
    ok: result.ok,
    expiresAt: Date.now() + (result.ok ? VALIDATION_TTL_MS : VALIDATION_FAILURE_TTL_MS),
  })
  return result.ok
}
