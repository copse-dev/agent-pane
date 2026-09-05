import { FETCH_TIMEOUTS } from '../fetch-timeouts.ts'
import { isRecord } from '@shared/unknown-value.ts'

const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models'
const CACHE_TTL_MS = 5 * 60 * 1_000

interface CachedModelIds {
  apiKey: string
  expiresAt: number
  ids: ReadonlySet<string>
}

let cached: CachedModelIds | undefined

function modelIdsFrom(payload: unknown): ReadonlySet<string> | null {
  if (typeof payload !== 'object' || payload === null || !('data' in payload)) return null
  const { data } = payload
  if (!Array.isArray(data)) return null
  const ids = new Set<string>()
  for (const model of data) {
    if (!isRecord(model)) continue
    const id = model['id']
    if (typeof id === 'string') ids.add(id)
  }
  return ids
}

/**
 * Whether this OpenAI account currently advertises a model. Early-access
 * models must be discovered from the account's own catalog: a valid key alone
 * does not imply the account can invoke them.
 */
export async function isOpenAiModelAvailable(apiKey: string, modelId: string): Promise<boolean> {
  const now = Date.now()
  if (cached?.apiKey === apiKey && cached.expiresAt > now) return cached.ids.has(modelId)

  try {
    const res = await fetch(OPENAI_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUTS.apiKeyValidation),
    })
    if (!res.ok) return false
    const ids = modelIdsFrom(await res.json())
    if (ids === null) return false
    cached = { apiKey, ids, expiresAt: now + CACHE_TTL_MS }
    return ids.has(modelId)
  } catch {
    return false
  }
}

/** Drop a previous account's catalog as soon as its credential changes. */
export function invalidateOpenAiModelAvailability(): void {
  cached = undefined
}
