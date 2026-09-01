import { validateApiKey } from './validate-api-key.ts'
import { resolveApiKey } from '../storage/settings.ts'

interface CachedValidation {
  key: string
  ok: boolean
  expiresAt: number
}

/** How long a successful key validation is reused before re-checking. */
const VALIDATION_TTL_MS = 5 * 60 * 1000

/** Failed validations retry sooner so a fixed key surfaces quickly. */
const VALIDATION_FAILURE_TTL_MS = 30 * 1000

const validationCache = new Map<string, CachedValidation>()
let validationGeneration = 0
const validationInflight = new Map<
  string,
  { key: string; generation: number; token: symbol; promise: Promise<boolean> }
>()

export function invalidateProviderKeyStatus(provider: string): void {
  validationGeneration += 1
  validationCache.delete(provider)
  validationInflight.delete(provider)
}

/** Seed the cache after an explicit validateKey call from Settings. */
export function recordProviderKeyValidation(provider: string, key: string, ok: boolean): void {
  validationGeneration += 1
  validationInflight.delete(provider)
  validationCache.set(provider, {
    key: key.trim(),
    ok,
    expiresAt: Date.now() + (ok ? VALIDATION_TTL_MS : VALIDATION_FAILURE_TTL_MS),
  })
}

export function clearProviderKeyStatusCache(): void {
  validationGeneration += 1
  validationCache.clear()
  validationInflight.clear()
}

/**
 * Whether a provider has a stored/env key that passed the last validation check.
 * Absent or blank keys are unavailable; a present but rejected key is too.
 */
export async function isProviderKeyUsable(provider: string): Promise<boolean> {
  const key = resolveApiKey(provider)?.trim()
  if (!key) return false

  const cached = validationCache.get(provider)
  if (cached?.key === key && cached.expiresAt > Date.now()) return cached.ok
  const existing = validationInflight.get(provider)
  if (existing?.key === key && existing.generation === validationGeneration) {
    return existing.promise
  }

  const generation = validationGeneration
  const token = Symbol(provider)
  const promise = (async (): Promise<boolean> => {
    try {
      const result = await validateApiKey(provider, key)
      if (generation === validationGeneration) {
        validationCache.set(provider, {
          key,
          ok: result.ok,
          expiresAt: Date.now() + (result.ok ? VALIDATION_TTL_MS : VALIDATION_FAILURE_TTL_MS),
        })
      }
      return result.ok
    } finally {
      if (validationInflight.get(provider)?.token === token) validationInflight.delete(provider)
    }
  })()
  validationInflight.set(provider, { key, generation, token, promise })
  return promise
}
