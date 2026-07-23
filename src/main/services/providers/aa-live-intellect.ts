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

/** Env override for e2e / demos — skips network and the stored AA key. */
const MOCK_ENV = 'COPSE_AA_INTELLECT_MOCK'

// The legacy `/data/llms/models` response does not carry the Intelligence
// Index cost-per-task field. The current free-shape endpoint does (for every
// API tier) and paginates at 200 rows, so request every page below.
const AA_MODELS_URL = 'https://artificialanalysis.ai/api/v2/language/models/free'
// AA data moves slowly; refetching each panel open would just burn quota.
const CACHE_TTL_MS = 6 * 60 * 60_000
// Failures (bad key, network, unparseable payload) are cached only briefly, so
// a user who fixes their key or waits out a blip recovers on the next panel
// open instead of being stuck behind a stale error for the full success TTL.
const FAILURE_CACHE_TTL_MS = 60_000
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
  /**
   * Documented AA Data API shape for Intelligence Index cost-per-task (USD).
   * Free tier exposes `total_cost` plus nested `cost_per_task.total_cost`.
   */
  artificial_analysis_intelligence_index_cost?: {
    total_cost?: number
    cost_per_task?: {
      total_cost?: number
    }
  }
  pricing?: {
    price_1m_input_tokens?: number
    price_1m_output_tokens?: number
    /** Legacy / alternate spellings — prefer the model-level cost object above. */
    price_per_intelligence_index_task?: number
    cost_per_task?: number
  }
}

interface AaApiPayload extends Record<string, unknown> {
  data?: AaApiModel[]
  pagination?: {
    page?: number
    total_pages?: number
    has_more?: boolean
  }
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

/**
 * How long a given result stays cached: a real cohort (successful fetch with
 * models) for the full TTL, anything else — an error or an empty/unparseable
 * payload — only briefly, so a transient or now-fixed condition recovers on
 * the next open rather than sticking for hours.
 */
export function liveCacheTtlMs(result: LiveIntellectFetch): number {
  return result.ok && result.models.length > 0 ? CACHE_TTL_MS : FAILURE_CACHE_TTL_MS
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
  // Docs: model-level `artificial_analysis_intelligence_index_cost.cost_per_task.total_cost`.
  // Keep legacy `pricing.*` keys as fallback only — they are not on the free-tier payload.
  const perTask =
    api.artificial_analysis_intelligence_index_cost?.cost_per_task?.total_cost ??
    api.pricing?.price_per_intelligence_index_task ??
    api.pricing?.cost_per_task
  if (typeof perTask === 'number' && Number.isFinite(perTask) && perTask > 0) {
    model.costPerTask = perTask
  }
  return model
}

/**
 * One live fetch of the AA model list, with no key lookup and no caching — the
 * pure HTTP+parse surface, so tests can drive it with a fake fetch.
 *
 * `redirect: 'follow'` deliberately matches the proven `sync:intellect
 * --from-api` path: the earlier `redirect: 'manual'` turned any AA-side
 * redirect (CDN, WAF, trailing-slash normalisation) into a silent failure here
 * while the sync script sailed through, which is exactly the "sync works but
 * the live panel doesn't" shape. The URL is a fixed trusted constant, so
 * following its redirects is safe.
 */
export async function requestLiveIntellectModels(
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LiveIntellectFetch> {
  try {
    const apiModels: AaApiModel[] = []
    let firstPayload: AaApiPayload = {}
    let page = 1
    let hasMore = true
    while (hasMore) {
      const url = new URL(AA_MODELS_URL)
      url.searchParams.set('page', String(page))
      const res = await fetchImpl(url, {
        headers: { 'x-api-key': key },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!res.ok) {
        const status = `HTTP ${String(res.status)}${res.statusText ? ` ${res.statusText}` : ''}`
        const hint =
          res.status === 401 || res.status === 403
            ? ' — the key was rejected; check the Artificial Analysis key in Settings'
            : ''
        return { ok: false, models: [], error: `Artificial Analysis API: ${status}${hint}` }
      }
      const payload = (await res.json()) as AaApiPayload
      if (page === 1) firstPayload = payload
      apiModels.push(...(payload.data ?? []))
      const pagination = payload.pagination
      hasMore =
        pagination?.has_more === true ||
        (typeof pagination?.total_pages === 'number' && page < pagination.total_pages)
      if (hasMore) page += 1
    }
    const models = apiModels.map(reduceModel).filter((m): m is LiveAaModel => m !== null)
    const indexVersion = reportedIndexVersion(firstPayload, apiModels)
    return { ok: true, models, ...(indexVersion !== undefined ? { indexVersion } : {}) }
  } catch (err) {
    return {
      ok: false,
      models: [],
      error: err instanceof Error ? err.message : 'Artificial Analysis API fetch failed',
    }
  }
}

/**
 * Deterministic live cohort for e2e: enough canonical anchors to pass the
 * scale gate, plus `costPerTask` so the value-map $/task axis is exercisable
 * without an Artificial Analysis API key.
 */
function mockLiveIntellectFetch(): LiveIntellectFetch {
  // Canonical-scale anchors (pass the live gate) plus GPT rows with task costs
  // so the $/task axis stays exercisable when plan coverage is hidden in e2e
  // (Claude and GPT models plot at $0 while their plan windows have headroom).
  const models: LiveAaModel[] = [
    {
      id: 'claude-fable-5',
      intellect: 59.9,
      inputPricePerMTok: 5,
      outputPricePerMTok: 25,
      costPerTask: 2.4,
    },
    {
      id: 'claude-opus-4-8',
      intellect: 55.7,
      inputPricePerMTok: 5,
      outputPricePerMTok: 25,
      costPerTask: 3.1,
    },
    {
      id: 'claude-sonnet-5',
      intellect: 53.4,
      inputPricePerMTok: 3,
      outputPricePerMTok: 15,
      costPerTask: 1.8,
    },
    {
      id: 'claude-sonnet-4-6',
      intellect: 35.9,
      inputPricePerMTok: 3,
      outputPricePerMTok: 15,
      costPerTask: 0.9,
    },
    {
      id: 'claude-haiku-4-5',
      intellect: 24,
      inputPricePerMTok: 1,
      outputPricePerMTok: 5,
      costPerTask: 0.25,
    },
    {
      id: 'gpt-5.6-sol',
      intellect: 59,
      inputPricePerMTok: 5,
      outputPricePerMTok: 25,
      costPerTask: 4.2,
    },
    {
      id: 'gpt-5.5',
      intellect: 55,
      inputPricePerMTok: 5,
      outputPricePerMTok: 25,
      costPerTask: 3.6,
    },
    {
      id: 'gpt-5.6-terra',
      intellect: 46,
      inputPricePerMTok: 2,
      outputPricePerMTok: 10,
      costPerTask: 1.4,
    },
    {
      id: 'gpt-5',
      intellect: 34.7,
      inputPricePerMTok: 2,
      outputPricePerMTok: 10,
      costPerTask: 1.1,
    },
    {
      id: 'gpt-5-mini',
      intellect: 25.3,
      inputPricePerMTok: 0.4,
      outputPricePerMTok: 1.6,
      costPerTask: 0.35,
    },
    {
      id: 'gpt-4o',
      intellect: 11.2,
      inputPricePerMTok: 2.5,
      outputPricePerMTok: 10,
      costPerTask: 0.55,
    },
    {
      id: 'gpt-4o-mini',
      intellect: 6.9,
      inputPricePerMTok: 0.15,
      outputPricePerMTok: 0.6,
      costPerTask: 0.12,
    },
    {
      id: 'cheap-smart-oss',
      intellect: 50,
      inputPricePerMTok: 0.2,
      outputPricePerMTok: 0.8,
      costPerTask: 0.4,
    },
  ]
  return { ok: true, models, indexVersion: '4.1' }
}

/**
 * The current AA model list, or an empty result when no key is stored (the
 * feature is simply off) or the fetch fails (the panel falls back to curated
 * data). Results are cached — a real cohort for hours, a failure only briefly
 * (see {@link liveCacheTtlMs}) — and the cache is dropped when the key changes
 * (register-handlers `settings:setKey`).
 */
export async function fetchLiveIntellectModels(): Promise<LiveIntellectFetch> {
  if (process.env[MOCK_ENV] === '1') return mockLiveIntellectFetch()
  const key = getApiKey('artificial-analysis')
  if (!key) return { ok: true, models: [] }
  if (cache && Date.now() - cache.at < liveCacheTtlMs(cache.result)) return cache.result

  const result = await requestLiveIntellectModels(key)
  cache = { at: Date.now(), result }
  return result
}
