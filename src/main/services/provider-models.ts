// Lists models from any OpenAI-compatible server's `/models` endpoint, for the
// "Fetch models" action when adding/editing a custom provider. Unlike the LM
// Studio fetch this takes the provider's own key verbatim (no local fallback)
// and does not probe LM Studio's native endpoint. The standard OpenAI `/models`
// payload has no context length, so `contextLength` is usually null and the UI
// falls back to the provider's configured window — but we still parse it when a
// server (e.g. LM Studio, vLLM) does include it.

import { FETCH_TIMEOUTS } from './fetch-timeouts.ts'
import { parseContextFromModelRecord, stripTrailingSlash } from './lm-studio-models.ts'

export interface FetchedProviderModel {
  id: string
  contextLength: number | null
}

export async function fetchOpenAiCompatibleModels(
  baseUrl: string,
  apiKey?: string,
): Promise<{ ok: boolean; models: FetchedProviderModel[]; error?: string }> {
  const base = stripTrailingSlash(baseUrl || '')
  if (!base) return { ok: false, models: [], error: 'Base URL is empty' }
  const key = apiKey?.trim()
  try {
    const res = await fetch(`${base}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(FETCH_TIMEOUTS.modelList),
    })
    if (!res.ok) {
      return { ok: false, models: [], error: `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}` }
    }
    const json: unknown = await res.json()
    const data = (json as { data?: unknown })?.data
    if (!Array.isArray(data)) return { ok: true, models: [] }
    const models: FetchedProviderModel[] = []
    for (const row of data) {
      if (!row || typeof row !== 'object') continue
      const rec = row as Record<string, unknown>
      const id = typeof rec.id === 'string' ? rec.id : typeof rec.model === 'string' ? rec.model : null
      if (!id) continue
      models.push({ id, contextLength: parseContextFromModelRecord(rec) })
    }
    return { ok: true, models }
  } catch (err) {
    return {
      ok: false,
      models: [],
      error: err instanceof Error ? err.message : 'Could not list models',
    }
  }
}
