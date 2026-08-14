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
import { z } from 'zod'
import { getApiKey } from '../storage/settings.ts'
import { optionalRecord } from '@shared/unknown-value.ts'

/** Env override for e2e / demos — skips network and the stored AA key. */
const MOCK_ENV = 'COPSE_AA_INTELLECT_MOCK'

// The supported free-tier language feed. It carries the Intelligence Index
// cost-per-task field (for every API tier) and paginates at 200 rows, so
// request every page below.
//
// This is also the documented replacement for the retired `/api/v2/data/*`
// family: AA's migration guide maps `/api/v2/data/llms/models` onto exactly
// this URL, and legacy paths return 410 Gone after 2026-11-04 23:59 UTC. The
// key is unchanged. Because the replacement IS the endpoint we already call
// first, the old "fall back to the legacy score feed on a bad payload" path
// has no successor and is gone — a second attempt would just be the same
// request. See https://artificialanalysis.ai/data-api/migrate-v2-data.
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

const aaApiModelSchema = z
  .object({
    id: z.string().nullish(),
    slug: z.string().nullish(),
    name: z.string().nullish(),
    evaluations: z
      .object({
        artificial_analysis_intelligence_index: z.number().nullish(),
        artificial_analysis_intelligence_index_version: z.union([z.string(), z.number()]).nullish(),
      })
      .nullish(),
    /**
     * Documented AA Data API shape for Intelligence Index cost-per-task (USD).
     * Free tier exposes `total_cost` plus nested `cost_per_task.total_cost`.
     */
    artificial_analysis_intelligence_index_cost: z
      .object({
        total_cost: z.number().nullish(),
        cost_per_task: z.object({ total_cost: z.number().nullish() }).nullish(),
      })
      .nullish(),
    pricing: z
      .object({
        price_1m_input_tokens: z.number().nullish(),
        price_1m_output_tokens: z.number().nullish(),
        /** Legacy / alternate spellings — prefer the model-level cost object above. */
        price_per_intelligence_index_task: z.number().nullish(),
        cost_per_task: z.number().nullish(),
      })
      .nullish(),
  })
  .loose()

type AaApiModel = z.infer<typeof aaApiModelSchema>

const aaApiPayloadSchema = z
  .object({
    data: z.array(aaApiModelSchema.nullable()).nullish(),
    pagination: z
      .object({
        page: z.number().optional(),
        total_pages: z.number().optional(),
        has_more: z.boolean().optional(),
      })
      .nullish(),
  })
  .loose()

type AaApiPayload = z.infer<typeof aaApiPayloadSchema>

class AaHttpError extends Error {
  readonly status: number
  readonly statusText: string

  constructor(status: number, statusText: string) {
    super(`HTTP ${String(status)}${statusText ? ` ${statusText}` : ''}`)
    this.name = 'AaHttpError'
    this.status = status
    this.statusText = statusText
  }
}

class AaPayloadError extends Error {
  constructor(cause?: unknown) {
    super('Artificial Analysis returned model data that does not match its published schema.', {
      cause,
    })
    this.name = 'AaPayloadError'
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
    const v = payload[key] ?? optionalRecord(payload['metadata'])?.[key]
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

interface AaEndpointResult {
  firstPayload: AaApiPayload
  models: AaApiModel[]
}

async function requestAaEndpoint(
  urlString: string,
  key: string,
  fetchImpl: typeof fetch,
): Promise<AaEndpointResult> {
  const models: AaApiModel[] = []
  let firstPayload: AaApiPayload = {}
  let page = 1
  let hasMore = true
  while (hasMore) {
    const url = new URL(urlString)
    url.searchParams.set('page', String(page))
    const res = await fetchImpl(url, {
      headers: { 'x-api-key': key },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) throw new AaHttpError(res.status, res.statusText)

    let payload: AaApiPayload
    try {
      payload = aaApiPayloadSchema.parse(await res.json())
    } catch (err) {
      // Some AA responses currently fail their generated response validator
      // because optional measurements are represented as null. Keep that
      // implementation detail out of the UI — the panel falls back to curated
      // data, and the short failure TTL means a fixed response recovers on the
      // next open.
      throw new AaPayloadError(err)
    }
    if (page === 1) firstPayload = payload
    models.push(...(payload.data ?? []).filter((model): model is AaApiModel => model !== null))

    const pagination = payload.pagination
    hasMore =
      pagination?.has_more === true ||
      (typeof pagination?.total_pages === 'number' && page < pagination.total_pages)
    if (hasMore) page += 1
  }
  return { firstPayload, models }
}

function errorMessage(err: unknown): string {
  if (err instanceof AaHttpError) {
    // 410 is AA's marker for a retired `/api/v2/data/*` path. We no longer call
    // one, so seeing it means the supported endpoint itself was retired and the
    // constant above needs revisiting — say so rather than blaming the key.
    const hint =
      err.status === 401 || err.status === 403
        ? ' — the key was rejected; check the Artificial Analysis key in Settings'
        : err.status === 410
          ? ' — this endpoint has been retired; the app needs an update'
          : ''
    return `Artificial Analysis API: ${err.message}${hint}`
  }
  return err instanceof Error ? err.message : 'Artificial Analysis API fetch failed'
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
 *
 * One endpoint, one attempt: the retired legacy feed's documented replacement
 * is this same URL, so there is nothing left to fall back to.
 */
export async function requestLiveIntellectModels(
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LiveIntellectFetch> {
  try {
    const endpoint = await requestAaEndpoint(AA_MODELS_URL, key, fetchImpl)
    const models = endpoint.models.map(reduceModel).filter((m): m is LiveAaModel => m !== null)
    const indexVersion = reportedIndexVersion(endpoint.firstPayload, endpoint.models)
    return { ok: true, models, ...(indexVersion !== undefined ? { indexVersion } : {}) }
  } catch (err) {
    return { ok: false, models: [], error: errorMessage(err) }
  }
}

/**
 * Deterministic live cohort for e2e: enough canonical anchors to pass the
 * scale gate, plus `costPerTask` so the value-map $/task axis is exercisable
 * without an Artificial Analysis API key.
 */
function mockLiveIntellectFetch(): LiveIntellectFetch {
  // Canonical-scale anchors (pass the live gate) plus GPT rows with task costs
  // so the $/task axis shows non-plan spread under COPSE_PLAN_USAGE_MOCK (Claude
  // models plot at $0 when their plan window still has headroom).
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
    // A curated score outside the routable catalog. This intentionally mirrors
    // the high-price legacy outlier in the AA cohort so renderer e2e proves it
    // stays in the discovery disclosure instead of stretching the chart axis.
    {
      id: 'o1-pro',
      intellect: 19.1,
      inputPricePerMTok: 150,
      outputPricePerMTok: 600,
      costPerTask: 12,
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
