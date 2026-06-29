// Fetches the Hugging Face Inference Providers catalogue and resolves it into
// priced, provider-pinned models for the Hugging Face built-in provider.
//
// Unlike the generic OpenAI `/models` fetch (`provider-models.ts`), HF's router
// returns, per model, a `providers[]` array where each entry carries that
// upstream provider's own pricing and context window. A model id like
// `org/model` is therefore not one price/size but several. We resolve each model
// to a single CHEAPEST provider that is live and tool-capable (the agent needs
// function calling), then PIN that provider into the model id (`org/model:together`)
// so requests route deterministically — instead of `:cheapest`, whose target
// (and thus price/context) can drift between fetch time and use.
//
// NOTE: the exact router JSON field names below (`providers`, `pricing.input`,
// `pricing.output`, `context_length`, `supports_tools`, `status`) are taken from
// HF's documented Hub API shape. Parsing is defensive (multiple key spellings,
// missing fields tolerated); verify against a live response if the import looks
// empty or mispriced.

import { FETCH_TIMEOUTS } from './fetch-timeouts.ts'
import type { ExtraProviderModel } from '@shared/llm/extra-providers.ts'

/** OpenAI-compatible base URL of the HF Inference Providers router. */
export const HUGGINGFACE_ROUTER_BASE_URL = 'https://router.huggingface.co/v1'

// electron-store schema caps a provider's model list at 256; keep within it.
const MAX_MODELS = 256

interface HfProviderEntry {
  provider: string
  contextLength: number | null
  inputPricePerMTok: number
  outputPricePerMTok: number
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    const n = Number(value)
    return n >= 0 ? n : null
  }
  return null
}

function readPricing(rec: Record<string, unknown>): { input: number; output: number } | null {
  const pricing = rec['pricing']
  if (!pricing || typeof pricing !== 'object') return null
  const p = pricing as Record<string, unknown>
  const input = num(p['input'] ?? p['input_per_million'] ?? p['prompt'])
  if (input === null) return null
  const output = num(p['output'] ?? p['output_per_million'] ?? p['completion'])
  return { input, output: output ?? input }
}

function readContextLength(rec: Record<string, unknown>): number | null {
  return num(
    rec['context_length'] ??
      rec['context_window'] ??
      rec['contextLength'] ??
      rec['max_context_length'],
  )
}

/**
 * The cheapest live, tool-capable provider for one model's `providers[]`, or
 * `null` when none qualifies. "Cheapest" ranks on input+output $/MTok. A provider
 * with no reported price can't be priced and is skipped; one explicitly flagged
 * `supports_tools: false` or with a non-live `status` is dropped (a missing flag
 * is treated as eligible so an under-populated payload still yields models).
 */
export function selectBestHfProvider(providers: unknown): HfProviderEntry | null {
  if (!Array.isArray(providers)) return null
  let best: HfProviderEntry | null = null
  for (const raw of providers) {
    if (!raw || typeof raw !== 'object') continue
    const rec = raw as Record<string, unknown>
    const name =
      typeof rec['provider'] === 'string'
        ? rec['provider']
        : typeof rec['name'] === 'string'
          ? rec['name']
          : null
    if (!name) continue
    if (rec['status'] !== undefined && rec['status'] !== 'live') continue
    if (rec['supports_tools'] === false) continue
    const pricing = readPricing(rec)
    if (!pricing) continue
    const entry: HfProviderEntry = {
      provider: name,
      contextLength: readContextLength(rec),
      inputPricePerMTok: pricing.input,
      outputPricePerMTok: pricing.output,
    }
    if (
      !best ||
      entry.inputPricePerMTok + entry.outputPricePerMTok <
        best.inputPricePerMTok + best.outputPricePerMTok
    ) {
      best = entry
    }
  }
  return best
}

/**
 * Resolve a router `/v1/models` payload into priced, provider-pinned models.
 * Each model id is rewritten to `org/model:<provider>` so the route is fixed.
 */
export function parseHuggingFaceModels(json: unknown): ExtraProviderModel[] {
  const data = (json as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []
  const out: ExtraProviderModel[] = []
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
    const best = selectBestHfProvider(rec['providers'])
    if (!best) continue
    out.push({
      // Pin the chosen provider so routing (and thus price/context) can't drift.
      id: `${id}:${best.provider}`,
      label: id,
      ...(best.contextLength ? { contextWindow: best.contextLength } : {}),
      inputPricePerMTok: best.inputPricePerMTok,
      outputPricePerMTok: best.outputPricePerMTok,
    })
  }
  return out.slice(0, MAX_MODELS)
}

/**
 * Fetch and resolve Hugging Face router models with the user's token. Returns the
 * priced, provider-pinned model list ready to persist on the `huggingface` provider.
 */
export async function fetchHuggingFaceModels(
  apiKey?: string,
): Promise<{ ok: boolean; models: ExtraProviderModel[]; error?: string }> {
  const key = apiKey?.trim()
  if (!key) return { ok: false, models: [], error: 'A Hugging Face token is required' }
  try {
    const res = await fetch(`${HUGGINGFACE_ROUTER_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUTS.modelList),
    })
    if (!res.ok) {
      return {
        ok: false,
        models: [],
        error: `HTTP ${String(res.status)}${res.statusText ? ` ${res.statusText}` : ''}`,
      }
    }
    const json: unknown = await res.json()
    return { ok: true, models: parseHuggingFaceModels(json) }
  } catch (err) {
    return {
      ok: false,
      models: [],
      error: err instanceof Error ? err.message : 'Could not list Hugging Face models',
    }
  }
}
