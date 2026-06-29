import { OPENROUTER_BASE_URL } from '@shared/llm/openrouter.ts'
import { FETCH_TIMEOUTS } from './fetch-timeouts.ts'
import { getSetting } from './settings.ts'

export interface OpenRouterModelSummary {
  id: string
  name: string
  contextLength: number | null
  /** Both prompt and completion priced at 0. */
  free: boolean
  /** `supported_parameters` advertises `tools` (i.e. can do function calling). */
  supportsTools: boolean
}

/** Picker-facing subset (already filtered to free + tool-capable). */
export interface OpenRouterModelOption {
  id: string
  name: string
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

function isFreePricing(pricing: unknown): boolean {
  if (!pricing || typeof pricing !== 'object') return false
  const p = pricing as Record<string, unknown>
  return priceValue(p['prompt']) === 0 && priceValue(p['completion']) === 0
}

// Keep text-output chat models; drop image/audio/video generators that also show
// up in /models (their pricing can read 0 on the prompt/completion fields).
function outputsText(architecture: unknown): boolean {
  if (!architecture || typeof architecture !== 'object') return true
  const arch = architecture as Record<string, unknown>
  if (Array.isArray(arch['output_modalities'])) return arch['output_modalities'].includes('text')
  const modality = typeof arch['modality'] === 'string' ? arch['modality'] : ''
  if (!modality) return true
  const output = modality.includes('->') ? (modality.split('->').pop() ?? '') : modality
  return output.includes('text')
}

function supportsTools(supportedParameters: unknown): boolean {
  return Array.isArray(supportedParameters) && supportedParameters.includes('tools')
}

function parseModelRow(row: unknown): OpenRouterModelSummary | null {
  if (!row || typeof row !== 'object') return null
  const rec = row as Record<string, unknown>
  const id = typeof rec['id'] === 'string' ? rec['id'] : null
  if (!id) return null
  if (!outputsText(rec['architecture'])) return null
  return {
    id,
    name: typeof rec['name'] === 'string' && rec['name'] ? rec['name'] : id,
    contextLength: parsePositiveInt(rec['context_length']),
    free: isFreePricing(rec['pricing']),
    supportsTools: supportsTools(rec['supported_parameters']),
  }
}

export function parseOpenRouterModelsPayload(json: unknown): OpenRouterModelSummary[] {
  // json is parsed from the network and can be null; the cast type hides that, so
  // the optional chain guards the genuine runtime case.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const data = (json as { data?: unknown })?.data
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
  return result
}

/** Free, tool-capable text models for the picker (sorted by display name). */
export async function listFreeOpenRouterModels(): Promise<OpenRouterModelOption[]> {
  const result = await fetchOpenRouterModelsCached()
  if (!result.ok) return []
  return result.models
    .filter((m) => m.free && m.supportsTools)
    .map((m) => ({ id: m.id, name: m.name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Context length for one OpenRouter model id (from the cached catalog). */
export async function openRouterModelContextLength(id: string): Promise<number | null> {
  const result = await fetchOpenRouterModelsCached()
  return result.models.find((m) => m.id === id)?.contextLength ?? null
}
