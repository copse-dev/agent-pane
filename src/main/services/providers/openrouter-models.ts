import { OPENROUTER_BASE_URL } from '@copse/llm/openrouter.ts'
import { FETCH_TIMEOUTS } from '../fetch-timeouts.ts'
import { getSetting } from '../storage/settings.ts'
import { rememberOpenRouterPricing } from './model-pricing-store.ts'
import { isRecord, optionalRecord } from '@shared/unknown-value.ts'

export interface OpenRouterModelSummary {
  id: string
  name: string
  contextLength: number | null
  /** Both prompt and completion priced at 0. */
  free: boolean
  /** `supported_parameters` advertises `tools` (i.e. can do function calling). */
  supportsTools: boolean
  /** Whether the catalog explicitly says image is an accepted input modality. */
  supportsImages?: boolean
  /** Catalog pricing converted from USD/token to USD/million tokens. */
  inputPricePerMTok: number | null
  outputPricePerMTok: number | null
  /**
   * Prompt-caching rates, when the route bills them separately. Absent (rather
   * than null) for the many routes that publish no caching prices, so a row
   * without caching stays byte-identical to what earlier versions parsed.
   */
  cacheReadPricePerMTok?: number | null
  cacheCreationPricePerMTok?: number | null
}

/** Picker-facing subset (already filtered to free + tool-capable). */
export interface OpenRouterModelOption {
  id: string
  name: string
  inputPricePerMTok: number | null
  outputPricePerMTok: number | null
  /** Absent when the upstream catalog does not describe input modalities. */
  supportsImages?: boolean
}

// The base is overridable via a (hidden) setting so e2e can point it at a local
// fixture server; production always uses OpenRouter's public catalog endpoint.
function openRouterApiBase(): string {
  return getSetting<string>('openRouterApiBase', OPENROUTER_BASE_URL).replace(/\/$/, '')
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = parseInt(value, 10)
    return n > 0 ? n : null
  }
  return null
}

// Pricing values come back as strings ("0", "0.000003") but tolerate numbers too.
function priceValue(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number.parseFloat(value)
  return Number.NaN
}

function pricePerMTok(value: unknown): number | null {
  const perToken = priceValue(value)
  return Number.isFinite(perToken) && perToken >= 0 ? perToken * 1_000_000 : null
}

function isFreePricing(pricing: unknown): boolean {
  if (!isRecord(pricing)) return false
  const p = pricing
  return priceValue(p['prompt']) === 0 && priceValue(p['completion']) === 0
}

// Keep text-output chat models; drop image/audio/video generators that also show
// up in /models (their pricing can read 0 on the prompt/completion fields).
function outputsText(architecture: unknown): boolean {
  if (!isRecord(architecture)) return true
  const arch = architecture
  if (Array.isArray(arch['output_modalities'])) return arch['output_modalities'].includes('text')
  const modality = typeof arch['modality'] === 'string' ? arch['modality'] : ''
  if (!modality) return true
  const output = modality.includes('->') ? (modality.split('->').pop() ?? '') : modality
  return output.includes('text')
}

/**
 * OpenRouter encodes the request/response shape as e.g. `text+image->text`.
 * Missing architecture is unknown (not false): older/custom catalog rows may
 * still accept images even though they do not advertise modalities.
 */
function imageInputSupport(architecture: unknown): boolean | undefined {
  if (!isRecord(architecture)) return undefined
  const inputModalities = architecture['input_modalities']
  if (Array.isArray(inputModalities)) {
    return inputModalities.some((modality) => modality === 'image')
  }
  const modality = architecture['modality']
  if (typeof modality !== 'string' || !modality.trim()) return undefined
  const input = modality.includes('->') ? (modality.split('->')[0] ?? '') : modality
  return input.split('+').some((part) => part.trim() === 'image')
}

function supportsTools(supportedParameters: unknown): boolean {
  return Array.isArray(supportedParameters) && supportedParameters.includes('tools')
}

function parseModelRow(row: unknown): OpenRouterModelSummary | null {
  if (!isRecord(row)) return null
  const rec = row
  const id = typeof rec['id'] === 'string' ? rec['id'] : null
  if (!id) return null
  if (!outputsText(rec['architecture'])) return null
  const supportsImages = imageInputSupport(rec['architecture'])
  const pricing = optionalRecord(rec['pricing'])
  // Caching rates are optional in the catalog and only meaningful for routes
  // that actually bill cached input, so an absent field stays absent rather
  // than becoming a null the estimator would have to special-case.
  const cacheRead = pricePerMTok(pricing?.['input_cache_read'])
  const cacheWrite = pricePerMTok(pricing?.['input_cache_write'])
  return {
    id,
    name: typeof rec['name'] === 'string' && rec['name'] ? rec['name'] : id,
    contextLength: parsePositiveInt(rec['context_length']),
    free: isFreePricing(rec['pricing']),
    supportsTools: supportsTools(rec['supported_parameters']),
    ...(supportsImages !== undefined ? { supportsImages } : {}),
    inputPricePerMTok: pricePerMTok(pricing?.['prompt']),
    outputPricePerMTok: pricePerMTok(pricing?.['completion']),
    ...(cacheRead !== null ? { cacheReadPricePerMTok: cacheRead } : {}),
    ...(cacheWrite !== null ? { cacheCreationPricePerMTok: cacheWrite } : {}),
  }
}

export function parseOpenRouterModelsPayload(json: unknown): OpenRouterModelSummary[] {
  const data = isRecord(json) ? json['data'] : undefined
  if (!Array.isArray(data)) return []
  const out: OpenRouterModelSummary[] = []
  for (const row of data) {
    const parsed = parseModelRow(row)
    if (parsed) out.push(parsed)
  }
  return out
}

async function fetchOpenRouterModels(): Promise<{
  ok: boolean
  models: OpenRouterModelSummary[]
  error?: string
}> {
  const base = openRouterApiBase()
  try {
    const res = await fetch(`${base}/models`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUTS.modelList),
    })
    if (!res.ok) {
      return {
        ok: false,
        models: [],
        error: `HTTP ${String(res.status)}${res.statusText ? ` ${res.statusText}` : ''}`,
      }
    }
    return { ok: true, models: parseOpenRouterModelsPayload(await res.json()) }
  } catch (err) {
    return {
      ok: false,
      models: [],
      error: err instanceof Error ? err.message : 'Could not reach OpenRouter',
    }
  }
}

const MODELS_TTL_MS = 5 * 60_000
let cache: {
  key: string
  at: number
  result: Awaited<ReturnType<typeof fetchOpenRouterModels>>
} | null = null

export function invalidateOpenRouterModelsCache(): void {
  cache = null
  zdrCache = null
}

/** All OpenRouter models (cached); failures are cached too to avoid repeat timeouts. */
export async function fetchOpenRouterModelsCached(): Promise<{
  ok: boolean
  models: OpenRouterModelSummary[]
  error?: string
}> {
  const key = openRouterApiBase()
  const now = Date.now()
  if (cache && cache.key === key && now - cache.at < MODELS_TTL_MS) return cache.result
  const result = await fetchOpenRouterModels()
  cache = { key, at: now, result }
  // Snapshot the catalog's rates so the usage ledger can price OpenRouter turns
  // without a network round-trip (and after a model leaves the catalog). Best
  // effort by design: pricing is a display concern, never a reason to fail a
  // model list. Fire-and-forget so the picker isn't held up by a settings write.
  if (result.ok) void rememberOpenRouterPricing(result.models).catch(() => {})
  return result
}

// ---- ZDR endpoint list ----------------------------------------------------
// OpenRouter publishes its zero-data-retention endpoints at /endpoints/zdr
// (documented, no auth, auto-updated on provider policy changes). Rows carry a
// display `model_name` plus an endpoint `name`; some payloads also expose a
// slug-like id. We collect every plausible identifier lowercased and match
// models on either display name or id, so a schema variation degrades to
// fewer matches rather than a parse failure.

function collectZdrIdentifiers(json: unknown): Set<string> {
  const out = new Set<string>()
  const data = isRecord(json) ? json['data'] : undefined
  if (!Array.isArray(data)) return out
  for (const row of data) {
    if (!isRecord(row)) continue
    const rec = row
    for (const key of ['model_name', 'name', 'model', 'model_slug', 'permaslug', 'slug']) {
      const value = rec[key]
      if (typeof value === 'string' && value.trim()) out.add(value.trim().toLowerCase())
    }
  }
  return out
}

async function fetchZdrIdentifiers(): Promise<Set<string>> {
  const base = openRouterApiBase()
  try {
    const res = await fetch(`${base}/endpoints/zdr`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUTS.modelList),
    })
    if (!res.ok) return new Set()
    return collectZdrIdentifiers(await res.json())
  } catch {
    return new Set()
  }
}

let zdrCache: { key: string; at: number; identifiers: Set<string> } | null = null

async function fetchZdrIdentifiersCached(): Promise<Set<string>> {
  const key = openRouterApiBase()
  const now = Date.now()
  if (zdrCache && zdrCache.key === key && now - zdrCache.at < MODELS_TTL_MS) {
    return zdrCache.identifiers
  }
  const identifiers = await fetchZdrIdentifiers()
  zdrCache = { key, at: now, identifiers }
  return identifiers
}

/**
 * Restrict `models` to those with at least one zero-data-retention endpoint.
 * Fails OPEN: an empty/unfetchable ZDR list leaves the input unfiltered. This
 * filter is picker UX only — the actual guarantee is request-level
 * (`provider.zdr`, see create-provider.ts), so a stale or missing list can
 * surface a model that then fails routing, but can never weaken enforcement.
 */
export function filterToZdrModels(
  models: OpenRouterModelOption[],
  zdrIdentifiers: ReadonlySet<string>,
): OpenRouterModelOption[] {
  if (zdrIdentifiers.size === 0) return models
  return models.filter(
    (m) => zdrIdentifiers.has(m.name.toLowerCase()) || zdrIdentifiers.has(m.id.toLowerCase()),
  )
}

/**
 * Free, tool-capable text models for the picker (sorted by display name).
 * When ZDR-only routing is enabled (default), the list is additionally
 * restricted to models with a zero-data-retention endpoint so the picker
 * doesn't offer selections that would deterministically fail routing.
 */
export async function listFreeOpenRouterModels(): Promise<OpenRouterModelOption[]> {
  const result = await fetchOpenRouterModelsCached()
  if (!result.ok) return []
  const freeOnly = getSetting<boolean>('openRouterFreeMode', false)
  let models = result.models
    .filter((m) => m.supportsTools && (freeOnly ? m.free : true))
    .map((m) => ({
      id: m.id,
      name: m.name,
      inputPricePerMTok: m.inputPricePerMTok,
      outputPricePerMTok: m.outputPricePerMTok,
      ...(m.supportsImages !== undefined ? { supportsImages: m.supportsImages } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  if (getSetting<boolean>('openRouterZdrOnly', true)) {
    models = filterToZdrModels(models, await fetchZdrIdentifiersCached())
  }
  return models
}

/** Context length for one OpenRouter model id (from the cached catalog). */
export async function openRouterModelContextLength(id: string): Promise<number | null> {
  const result = await fetchOpenRouterModelsCached()
  return result.models.find((m) => m.id === id)?.contextLength ?? null
}
