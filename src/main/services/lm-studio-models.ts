import { getLmStudioApiKey } from './settings.ts'
import { DEFAULT_LM_STUDIO_URL } from '@shared/lm-studio-defaults.ts'
import { FETCH_TIMEOUTS } from './fetch-timeouts.ts'

export interface LmStudioModelInfo {
  id: string
  contextLength: number | null
}

export function lmStudioApiKey(override?: string): string {
  const trimmed = override?.trim()
  if (trimmed) return trimmed
  return getLmStudioApiKey()
}

/** Drop a single trailing slash, preserving the path (e.g. keeps `/v1`). */
export function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, '')
}

/** OpenAI base URL → server origin (strip trailing slash and `/v1`). */
export function lmStudioOrigin(openAiBaseUrl: string): string {
  const trimmed = stripTrailingSlash(openAiBaseUrl || DEFAULT_LM_STUDIO_URL)
  return trimmed.replace(/\/v1$/i, '')
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = parseInt(value, 10)
    return n > 0 ? n : null
  }
  return null
}

/** Best-effort context length from one LM Studio /models row (OpenAI or native v1). */
export function parseContextFromModelRecord(record: Record<string, unknown>): number | null {
  const direct = [
    record['max_context_length'],
    record['context_length'],
    record['contextLength'],
    record['n_ctx'],
    record['max_model_len'],
    record['loaded_context_length'],
    record['session_context_length'],
  ]
  for (const value of direct) {
    const n = parsePositiveInt(value)
    if (n) return n
  }

  for (const nestedKey of ['load_config', 'loadConfig', 'config', 'runtime', 'state'] as const) {
    const nested = record[nestedKey]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const fromNested = parseContextFromModelRecord(nested as Record<string, unknown>)
      if (fromNested) return fromNested
    }
  }

  return null
}

function parseOpenAiModelsPayload(json: unknown): LmStudioModelInfo[] {
  // `json` comes from JSON.parse of an external HTTP response and can genuinely
  // be null/undefined, so the optional chain is load-bearing.
  const data = (json as { data?: unknown } | null | undefined)?.data
  if (!Array.isArray(data)) return []
  const out: LmStudioModelInfo[] = []
  for (const row of data) {
    if (!row || typeof row !== 'object') continue
    const rec = row as Record<string, unknown>
    const id =
      typeof rec['id'] === 'string'
        ? rec['id']
        : typeof rec['model'] === 'string'
          ? rec['model']
          : null
    if (!id) continue
    out.push({ id, contextLength: parseContextFromModelRecord(rec) })
  }
  return out
}

/** Loaded n_ctx from LM Studio native API (not the catalog max). */
export function effectiveContextFromNativeModelRecord(
  record: Record<string, unknown>,
): number | null {
  const loaded = record['loaded_instances']
  if (Array.isArray(loaded)) {
    for (const inst of loaded) {
      if (!inst || typeof inst !== 'object') continue
      const config = (inst as Record<string, unknown>)['config']
      if (config && typeof config === 'object' && !Array.isArray(config)) {
        const n = parsePositiveInt((config as Record<string, unknown>)['context_length'])
        if (n) return n
      }
    }
  }
  return parsePositiveInt(record['max_context_length'])
}

function parseNativeV1ModelsPayload(json: unknown): LmStudioModelInfo[] {
  const root = json as Record<string, unknown>
  const list = root['models'] ?? root['data']
  if (!Array.isArray(list)) return []
  const out: LmStudioModelInfo[] = []
  for (const row of list) {
    if (!row || typeof row !== 'object') continue
    const rec = row as Record<string, unknown>
    const id =
      (typeof rec['key'] === 'string' && rec['key']) ||
      (typeof rec['id'] === 'string' && rec['id']) ||
      (typeof rec['identifier'] === 'string' && rec['identifier']) ||
      (typeof rec['model_key'] === 'string' && rec['model_key']) ||
      null
    if (!id) continue
    out.push({ id, contextLength: effectiveContextFromNativeModelRecord(rec) })
  }
  return out
}

function mergeOpenAiWithNativeContext(
  openAi: LmStudioModelInfo[],
  native: LmStudioModelInfo[],
): LmStudioModelInfo[] {
  const contextById = new Map<string, number>()
  for (const m of native) {
    if (m.contextLength) contextById.set(m.id, m.contextLength)
  }
  if (openAi.length === 0) return native
  return openAi.map((m) => ({
    id: m.id,
    contextLength: contextById.get(m.id) ?? m.contextLength,
  }))
}

async function fetchJson(
  url: string,
  apiKey: string,
): Promise<{ ok: boolean; json?: unknown; status?: number; statusText?: string }> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUTS.modelList),
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) {
      return { ok: false, status: res.status, statusText: res.statusText }
    }
    return { ok: true, json: await res.json() }
  } catch {
    return { ok: false }
  }
}

/**
 * Lists models exposed by LM Studio and, when the server provides it, each model’s
 * loaded/effective context length (matches what you set when loading in LM Studio).
 */
export async function fetchLmStudioModels(
  openAiBaseUrl: string,
  apiKey?: string,
): Promise<{ ok: boolean; models: LmStudioModelInfo[]; error?: string }> {
  const base = stripTrailingSlash(openAiBaseUrl || DEFAULT_LM_STUDIO_URL)
  const key = lmStudioApiKey(apiKey)
  const origin = lmStudioOrigin(base)

  const [openAi, native] = await Promise.all([
    fetchJson(`${base}/models`, key),
    fetchJson(`${origin}/api/v1/models`, key),
  ])

  const openAiModels = openAi.ok && openAi.json ? parseOpenAiModelsPayload(openAi.json) : []
  const nativeModels = native.ok && native.json ? parseNativeV1ModelsPayload(native.json) : []
  const merged = mergeOpenAiWithNativeContext(openAiModels, nativeModels)
  if (merged.length > 0) return { ok: true, models: merged }

  if (openAi.ok) return { ok: true, models: openAiModels }
  const status = openAi.status
  const statusText = openAi.statusText
  if (status) {
    return {
      ok: false,
      models: [],
      error: `HTTP ${String(status)}${statusText ? ` ${statusText}` : ''}`,
    }
  }
  return {
    ok: false,
    models: [],
    error: 'Could not list models from LM Studio',
  }
}

export function contextLengthForModel(models: LmStudioModelInfo[], modelId: string): number | null {
  const row = models.find((m) => m.id === modelId)
  return row?.contextLength ?? null
}

const LM_MODELS_TTL_MS = 60_000
let lmModelsCache: {
  key: string
  at: number
  result: { ok: boolean; models: LmStudioModelInfo[]; error?: string }
} | null = null

export function invalidateLmStudioModelsCache(): void {
  lmModelsCache = null
}

/** Cached models list (URL + API key); failures cached to avoid repeated timeouts. */
export async function fetchLmStudioModelsCached(
  openAiBaseUrl: string,
  apiKey?: string,
): Promise<{ ok: boolean; models: LmStudioModelInfo[]; error?: string }> {
  const url = stripTrailingSlash(openAiBaseUrl || DEFAULT_LM_STUDIO_URL)
  const key = lmStudioApiKey(apiKey)
  const cacheKey = `${url}${key}`
  const now = Date.now()
  if (
    lmModelsCache &&
    lmModelsCache.key === cacheKey &&
    now - lmModelsCache.at < LM_MODELS_TTL_MS
  ) {
    return lmModelsCache.result
  }
  const result = await fetchLmStudioModels(url, key)
  lmModelsCache = { key: cacheKey, at: now, result }
  return result
}
