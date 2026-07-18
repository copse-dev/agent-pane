// Live Artificial Analysis Intelligence Index feed, for the model value map.
// Fetches AA's model list with the device-stored key (slug
// 'artificial-analysis' — stored like the GitHub token: not an LLM provider,
// no env fallback, no validation endpoint) and reduces it to the shape the
// renderer's anchor gate consumes (`@copse/llm/live-intellect.ts` decides
// whether the feed is on the canonical scale — this service never interprets
// scores). Cached in-memory with a long TTL: AA republishes at most a few
// times a week, and their free tier requires attribution, which the UI shows
// whenever live data renders.

import type { LiveAaModel } from '@copse/llm/live-intellect.ts'
import { getApiKey } from '../storage/settings.ts'

const AA_MODELS_URL = 'https://artificialanalysis.ai/api/v2/data/llms/models'
// AA data moves slowly; refetching each panel open would just burn quota.
const CACHE_TTL_MS = 6 * 60 * 60_000
const FETCH_TIMEOUT_MS = 10_000

export interface LiveIntellectFetch {
  ok: boolean
  /** Empty when no key is configured or the fetch failed. */
  models: LiveAaModel[]
  /** Index version the feed declared its scores belong to (e.g. "4.1"). */
  indexVersion?: string | number
  /** Set when ok is false and there is something actionable to show. */
  error?: string
}

interface AaApiModel {
  id?: string
  slug?: string
  name?: string
  evaluations?: {
    artificial_analysis_intelligence_index?: number
    artificial_analysis_intelligence_index_version?: string | number
  }
  pricing?: { price_1m_input_tokens?: number; price_1m_output_tokens?: number }
}

/**
 * The index version the payload declares — the docs place it as a version
 * field alongside the intelligence index; accept the plausible spellings at
 * both payload and per-model level, first hit wins.
 */
function reportedIndexVersion(
  payload: Record<string, unknown>,
  models: readonly AaApiModel[],
): string | number | undefined {
  for (const key of [
    'artificial_analysis_intelligence_index_version',
    'intelligence_index_version',
  ]) {
    const v = payload[key] ?? (payload['metadata'] as Record<string, unknown> | undefined)?.[key]
    if (typeof v === 'string' || typeof v === 'number') return v
  }
  for (const m of models) {
    const v = m.evaluations?.artificial_analysis_intelligence_index_version
    if (typeof v === 'string' || typeof v === 'number') return v
  }
  return undefined
}

let cache: { at: number; result: LiveIntellectFetch } | null = null

export function invalidateLiveIntellectCache(): void {
  cache = null
}

function reduceModel(api: AaApiModel): LiveAaModel | null {
  const intellect = api.evaluations?.artificial_analysis_intelligence_index
  if (typeof intellect !== 'number' || !Number.isFinite(intellect)) return null
  const id = api.slug ?? api.name ?? api.id
  if (!id) return null
  const input = api.pricing?.price_1m_input_tokens
  const output = api.pricing?.price_1m_output_tokens
  const model: LiveAaModel = { id, intellect }
  if (typeof input === 'number' && Number.isFinite(input)) {
    model.inputPricePerMTok = input
    if (typeof output === 'number' && Number.isFinite(output)) model.outputPricePerMTok = output
  }
  return model
}

/**
 * The current AA model list, or an empty result when no key is stored (the
 * feature is simply off) or the fetch fails (the panel falls back to curated
 * data). Failures are cached too, so an unreachable API doesn't retry on
 * every panel refresh.
 */
export async function fetchLiveIntellectModels(): Promise<LiveIntellectFetch> {
  const key = getApiKey('artificial-analysis')
  if (!key) return { ok: true, models: [] }
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.result

  let result: LiveIntellectFetch
  try {
    const res = await fetch(AA_MODELS_URL, {
      headers: { 'x-api-key': key },
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      result = {
        ok: false,
        models: [],
        error: `Artificial Analysis API: HTTP ${String(res.status)}`,
      }
    } else {
      const payload = (await res.json()) as Record<string, unknown> & { data?: AaApiModel[] }
      const apiModels = payload.data ?? []
      const models = apiModels.map(reduceModel).filter((m): m is LiveAaModel => m !== null)
      const indexVersion = reportedIndexVersion(payload, apiModels)
      result = { ok: true, models, ...(indexVersion !== undefined ? { indexVersion } : {}) }
    }
  } catch (err) {
    result = {
      ok: false,
      models: [],
      error: err instanceof Error ? err.message : 'Artificial Analysis API fetch failed',
    }
  }
  cache = { at: Date.now(), result }
  return result
}
