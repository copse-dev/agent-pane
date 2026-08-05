// Resolves a model to a card URL that actually loads, and remembers the answer.
//
// `@copse/llm/model-cards.ts` returns only links it is certain of. This service
// covers the rest: it walks the ordered candidates from
// `model-card-candidates.ts` — the reviewed link first, then Hugging Face paths
// derived from the id and from the names other providers serve the same weights
// under — and returns the first that resolves. A model with no card resolves to
// null and the UI shows no link, which is the point: nothing is displayed that
// would 404 when clicked.
//
// The cache is the load-bearing part. Probing is keyed by URL (not by model, so
// the shared Anthropic hub is checked once for every Claude id) and persisted,
// so a given URL is fetched at most once per TTL across the app's whole
// lifetime, not once per hover. Failures are cached too, with a shorter TTL —
// without negative caching, a model with no card would re-probe every candidate
// forever, which is exactly the "refetching forever" this exists to stop.
//
// Requests are HEAD where possible (we only need the status), fall back to GET
// on the many hosts that reject HEAD, run at a small fixed concurrency, and are
// de-duplicated while in flight so a burst of hovers collapses to one call.

import { FETCH_TIMEOUTS } from '../fetch-timeouts.ts'
import { getSetting, setSetting } from '../storage/settings.ts'
import { modelCardCandidates, type ModelCardCandidate } from '@copse/llm/model-card-candidates.ts'
import { isRecord } from '@shared/unknown-value.ts'

/** Env override for e2e / demos: `1` resolves every candidate, `0` resolves none. */
const MOCK_ENV = 'COPSE_MODEL_CARD_PROBE_MOCK'

const CACHE_SETTING_KEY = 'modelCardProbeCache'

/**
 * A card URL that resolved stays trusted for a month: vendors do move cards,
 * but not weekly, and a stale-but-live link is a far cheaper error than
 * re-probing every vendor on every app start.
 */
export const PROBE_OK_TTL_MS = 30 * 24 * 60 * 60_000
/**
 * A failure is re-checked after a day. Long enough that a model with no card
 * does not re-probe on every hover; short enough that a newly published card,
 * or a probe that failed because the user was offline, is picked up soon.
 */
export const PROBE_FAIL_TTL_MS = 24 * 60 * 60_000

/** Keep the persisted map bounded — it is a cache, not a record. */
const MAX_CACHE_ENTRIES = 512
/** Small enough to stay polite to vendor sites, big enough to warm a chart. */
const MAX_CONCURRENT_PROBES = 4

export interface ProbeCacheEntry {
  ok: boolean
  /** Epoch ms of the probe. */
  at: number
}

export interface ResolvedModelCard extends ModelCardCandidate {
  /** True when a probe confirmed the URL loads (false only in the mock path). */
  verified: boolean
}

type ProbeCache = Record<string, ProbeCacheEntry>

let cache: ProbeCache | null = null
let persistTimer: ReturnType<typeof setTimeout> | undefined
const inFlight = new Map<string, Promise<boolean>>()
let active = 0
const queue: Array<() => void> = []

function loadCache(): ProbeCache {
  if (cache) return cache
  const raw = getSetting<unknown>(CACHE_SETTING_KEY, {})
  const out: ProbeCache = {}
  if (isRecord(raw)) {
    for (const [url, value] of Object.entries(raw)) {
      if (!isRecord(value)) continue
      const ok = value['ok']
      const at = value['at']
      if (typeof ok === 'boolean' && typeof at === 'number') out[url] = { ok, at }
    }
  }
  cache = out
  return out
}

/** Coalesce writes: a chart warm-up resolves many URLs in one burst. */
function schedulePersist(): void {
  if (persistTimer !== undefined) return
  persistTimer = setTimeout(() => {
    persistTimer = undefined
    const current = cache
    if (!current) return
    // Evict oldest-first when over the cap, so the cache cannot grow without
    // bound as a user tries models.
    const entries = Object.entries(current).sort((a, b) => b[1].at - a[1].at)
    const kept = Object.fromEntries(entries.slice(0, MAX_CACHE_ENTRIES))
    cache = kept
    void setSetting(CACHE_SETTING_KEY, kept).catch(() => {
      /* a cache that fails to persist is still correct in memory */
    })
  }, 1_000)
}

function cached(url: string, now: number): boolean | null {
  const entry = loadCache()[url]
  if (!entry) return null
  const ttl = entry.ok ? PROBE_OK_TTL_MS : PROBE_FAIL_TTL_MS
  // A clock that moved backwards would otherwise pin an entry as fresh forever.
  if (now - entry.at >= ttl || now < entry.at) return null
  return entry.ok
}

function remember(url: string, ok: boolean, now: number): void {
  loadCache()[url] = { ok, at: now }
  schedulePersist()
}

function withSlot<T>(run: () => Promise<T>): Promise<T> {
  const start = async (): Promise<T> => {
    active += 1
    try {
      return await run()
    } finally {
      active -= 1
      queue.shift()?.()
    }
  }
  if (active < MAX_CONCURRENT_PROBES) return start()
  return new Promise<T>((resolve, reject) => {
    queue.push(() => {
      start().then(resolve, reject)
    })
  })
}

async function request(url: string, method: 'HEAD' | 'GET'): Promise<number | null> {
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUTS.modelCardProbe),
    })
    return res.status
  } catch {
    return null
  }
}

/**
 * Does this URL load? HEAD first because the body is irrelevant, then GET for
 * the hosts that answer HEAD with 403/404/405 despite serving the page — a
 * false negative there would silently hide a real card.
 */
async function probe(url: string): Promise<boolean> {
  const head = await request(url, 'HEAD')
  if (head !== null && head >= 200 && head < 400) return true
  if (head !== null && head !== 403 && head !== 404 && head !== 405) return false
  const get = await request(url, 'GET')
  return get !== null && get >= 200 && get < 400
}

function mockOutcome(): boolean | null {
  const flag = process.env[MOCK_ENV]
  if (flag === undefined || flag === '') return null
  return flag !== '0'
}

/** Probe a URL, honouring the cache and collapsing concurrent callers. */
async function probeCached(url: string, now: number): Promise<boolean> {
  const hit = cached(url, now)
  if (hit !== null) return hit
  const existing = inFlight.get(url)
  if (existing) return existing
  const run = withSlot(() => probe(url))
    .then((ok) => {
      remember(url, ok, Date.now())
      return ok
    })
    .finally(() => {
      inFlight.delete(url)
    })
  inFlight.set(url, run)
  return run
}

/**
 * The first card URL for this model that resolves, or null when none does.
 * Cheap to call repeatedly: a fully-cached model costs no network at all.
 */
export async function resolveModelCard(modelId: string): Promise<ResolvedModelCard | null> {
  const candidates = modelCardCandidates(modelId)
  if (candidates.length === 0) return null

  const mock = mockOutcome()
  if (mock !== null) {
    const first = candidates[0]
    return mock && first ? { ...first, verified: false } : null
  }

  const now = Date.now()
  // Sequential by design: candidates are ordered by confidence, so the moment a
  // better one resolves the weaker guesses must not be probed at all.
  for (const candidate of candidates) {
    if (await probeCached(candidate.url, now)) return { ...candidate, verified: true }
  }
  return null
}

/** Reset in-memory state. Tests only — the persisted cache is left alone. */
export function resetModelCardResolverCache(): void {
  cache = null
  inFlight.clear()
  if (persistTimer !== undefined) clearTimeout(persistTimer)
  persistTimer = undefined
}
