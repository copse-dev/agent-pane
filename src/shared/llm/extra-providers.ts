// OpenAI-compatible "extra" providers offered alongside OpenRouter. The app
// ships a few curated presets (Mistral, Google Gemini, DeepSeek) and lets the
// user add as many more OpenAI-compatible endpoints as they like. Every one of
// them speaks the OpenAI chat API, so — like OpenRouter — it is reached through
// `OpenAIProvider` with a custom base URL (see create-provider.ts).
//
// A provider is identified by a single slug (see provider-slug.ts). Selected
// models are stored as `<slug>:<modelId>` (e.g. `gemini:gemini-2.5-flash`),
// mirroring `openrouter:` / `lmstudio:`, so the rest of the app can tell the
// selection apart from a bare cloud model id and strip the slug before sending
// it upstream. The same slug is the API-key lookup id (`apiKey.<slug>`).
//
// Built-in presets keep a reserved slug, a locked label/base URL, and an env-var
// fallback; the user may still edit their key, model shortlist, and overrides.
// User-added providers store everything. The effective provider list is the
// presets merged with the stored overrides/customs via `resolveExtraProviders`.

import { OPENROUTER_MODEL_PREFIX } from './openrouter.ts'
import { REMOTE_AGENT_MODEL_PREFIX } from '../remote-agent.ts'

/** Fallback context window for any provider/model whose size we don't know. */
export const DEFAULT_EXTRA_PROVIDER_CONTEXT = 128_000

/**
 * True when a base URL points at a loopback / local-bind host. This covers the
 * full 127.0.0.0/8 range (127.0.0.1, 127.0.1.1, …), localhost / *.localhost,
 * IPv6 loopback (::1), and the unspecified bind addresses 0.0.0.0 and :: that
 * vLLM/llama.cpp commonly listen on. Such providers are local OpenAI-compatible
 * servers (LM Studio, Ollama, llama.cpp, …): they are surfaced in Settings →
 * Local models, usually need no API key, and `http:` is acceptable. A single
 * derived predicate so the new local presets and any user-added local endpoint
 * are classified the same way.
 */
export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    let host = new URL(baseUrl).hostname.toLowerCase()
    // Unwrap a properly-bracketed IPv6 literal ([::1] → ::1); leave any host
    // with mismatched brackets untouched so it can't masquerade as local.
    const bracketed = /^\[(.*)\]$/.exec(host)
    if (bracketed) host = bracketed[1] ?? host
    return (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      // Entire 127.0.0.0/8 loopback range.
      /^127(?:\.\d{1,3}){3}$/.test(host) ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host === '::'
    )
  } catch {
    return false
  }
}

export interface ExtraProviderModel {
  /** Upstream model id sent to the provider. */
  id: string
  /** Human label shown in the picker (defaults to the id). */
  label?: string
  /** Context window (tokens) used for history trimming; falls back per provider. */
  contextWindow?: number
  /** USD per million input tokens, when the provider reports a rate (e.g. HF router). */
  inputPricePerMTok?: number
  /** USD per million output tokens, when the provider reports a rate. */
  outputPricePerMTok?: number
}

export interface ExtraProvider {
  /** Stable slug: model-selection prefix source and API-key lookup id. */
  id: string
  /** Human label / picker optgroup heading. */
  label: string
  /** Model-selection prefix, always `${id}:`. */
  prefix: string
  /** OpenAI-compatible base URL the SDK talks to. */
  baseUrl: string
  /** True for a shipped preset (locked label/base URL, env-var fallback). */
  builtin: boolean
  /**
   * True when the base URL is a loopback/local server. Local providers render in
   * Settings → Local models (not the cloud Providers panel) and are usable
   * without an API key. Derived from the base URL via `isLocalBaseUrl`.
   */
  local: boolean
  /** Env var that can also supply the key (presets only). */
  envVar?: string
  /** Settings → API Keys field copy. */
  keyLabel: string
  keyPlaceholder: string
  keyHint: string
  /** Optional key-format prefix, checked before any network call. */
  keyPrefix?: string
  /** Context window used when a selected model has no known size of its own. */
  fallbackContextWindow: number
  /** OpenAI `stream_options.include_usage`. Defaults on for cloud, off for localhost. */
  includeUsage?: boolean
  /** Extra fields merged into every request body (e.g. OpenRouter routing hints). */
  extraBody?: Record<string, unknown>
  /** Curated/known model shortlist for the picker (may be empty for a fresh custom). */
  models: readonly ExtraProviderModel[]
}

/** Persisted override (for a preset) or full definition (for a user custom). */
export interface StoredExtraProvider {
  slug: string
  /** Custom only — presets keep their locked label/base URL. */
  label?: string
  baseUrl?: string
  keyPrefix?: string
  /** Replaces the default model shortlist when present. */
  models?: ExtraProviderModel[]
  fallbackContextWindow?: number
  includeUsage?: boolean
  extraBody?: Record<string, unknown>
}

// Mistral and DeepSeek serve up to 128K context; Gemini Flash serves ~1M.
const MISTRAL_CONTEXT = 128_000
const GEMINI_CONTEXT = 1_048_576
// DeepSeek's API caps context at 64K even though the weights support more.
const DEEPSEEK_CONTEXT = 65_536

export const BUILTIN_EXTRA_PROVIDERS: readonly ExtraProvider[] = [
  {
    id: 'mistral',
    label: 'Mistral',
    prefix: 'mistral:',
    baseUrl: 'https://api.mistral.ai/v1',
    builtin: true,
    local: false,
    envVar: 'MISTRAL_API_KEY',
    keyLabel: 'Mistral API key',
    keyPlaceholder: 'Mistral API key',
    keyHint:
      "For Mistral models on La Plateforme's free Experiment tier. Validated via a free models request.",
    fallbackContextWindow: MISTRAL_CONTEXT,
    includeUsage: true,
    models: [
      {
        id: 'mistral-small-latest',
        label: 'Mistral Small (free tier)',
        contextWindow: MISTRAL_CONTEXT,
      },
      {
        id: 'open-mistral-nemo',
        label: 'Mistral Nemo (free tier)',
        contextWindow: MISTRAL_CONTEXT,
      },
      { id: 'mistral-large-latest', label: 'Mistral Large', contextWindow: MISTRAL_CONTEXT },
    ],
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    prefix: 'gemini:',
    // Google's OpenAI-compatibility layer (accepts an `Authorization: Bearer` key).
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    builtin: true,
    local: false,
    envVar: 'GEMINI_API_KEY',
    keyLabel: 'Google Gemini API key',
    keyPlaceholder: 'AIza…',
    keyHint:
      'For Gemini Flash models on the free tier (rate-limited, no card). Get a key at aistudio.google.com.',
    keyPrefix: 'AIza',
    fallbackContextWindow: GEMINI_CONTEXT,
    includeUsage: true,
    models: [
      {
        id: 'gemini-2.5-flash',
        label: 'Gemini 2.5 Flash (free tier)',
        contextWindow: GEMINI_CONTEXT,
      },
      {
        id: 'gemini-2.5-flash-lite',
        label: 'Gemini 2.5 Flash-Lite (free tier)',
        contextWindow: GEMINI_CONTEXT,
      },
      {
        id: 'gemini-2.0-flash',
        label: 'Gemini 2.0 Flash (free tier)',
        contextWindow: GEMINI_CONTEXT,
      },
      {
        id: 'gemini-2.0-flash-lite',
        label: 'Gemini 2.0 Flash-Lite (free tier)',
        contextWindow: GEMINI_CONTEXT,
      },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    prefix: 'deepseek:',
    baseUrl: 'https://api.deepseek.com',
    builtin: true,
    local: false,
    envVar: 'DEEPSEEK_API_KEY',
    keyLabel: 'DeepSeek API key',
    keyPlaceholder: 'sk-…',
    keyHint:
      'For DeepSeek models — very cheap pay-as-you-go, with off-peak discounts. Validated via a free models request.',
    keyPrefix: 'sk-',
    fallbackContextWindow: DEEPSEEK_CONTEXT,
    includeUsage: true,
    // Only `deepseek-chat` (V3) reliably supports function calling, which this
    // agent needs; `deepseek-reasoner` is intentionally omitted.
    models: [
      {
        id: 'deepseek-chat',
        label: 'DeepSeek V3 (deepseek-chat)',
        contextWindow: DEEPSEEK_CONTEXT,
      },
    ],
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    prefix: 'huggingface:',
    // HF Inference Providers router — OpenAI-compatible, fans out to Together,
    // Novita, Fireworks, etc. Model ids are `org/model[:routing]`, e.g.
    // `zai-org/GLM-5.2:fastest`; the routing suffix survives our slug strip.
    baseUrl: 'https://router.huggingface.co/v1',
    builtin: true,
    local: false,
    envVar: 'HF_TOKEN',
    keyLabel: 'Hugging Face token',
    keyPlaceholder: 'hf_…',
    keyHint:
      'For Hugging Face Inference Providers (serverless). Pick a model with Fetch models or type one like org/model:fastest. Get a token at huggingface.co/settings/tokens.',
    keyPrefix: 'hf_',
    // Context varies per upstream model; keep the generic 128K default.
    fallbackContextWindow: DEFAULT_EXTRA_PROVIDER_CONTEXT,
    includeUsage: true,
    // Bring-your-own model id (huge, fast-moving catalog): no curated shortlist.
    models: [],
  },
  // Local OpenAI-compatible servers. Loopback base URLs mark them `local` (see
  // isLocalBaseUrl): they render in Settings → Local models, accept `http:`, and
  // work without an API key. Models are bring-your-own — use "Fetch models" in
  // the Local providers panel to import what the running server exposes.
  {
    id: 'ollama',
    label: 'Ollama',
    prefix: 'ollama:',
    baseUrl: 'http://localhost:11434/v1',
    builtin: true,
    local: true,
    keyLabel: 'Ollama API key',
    keyPlaceholder: 'usually none',
    keyHint:
      'Local Ollama server (OpenAI-compatible). No API key unless you configured one. Start it with `ollama serve`, then Fetch models.',
    fallbackContextWindow: DEFAULT_EXTRA_PROVIDER_CONTEXT,
    includeUsage: false,
    models: [],
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp',
    prefix: 'llamacpp:',
    baseUrl: 'http://localhost:8080/v1',
    builtin: true,
    local: true,
    keyLabel: 'llama.cpp API key',
    keyPlaceholder: 'usually none',
    keyHint:
      "Local llama.cpp server (`llama-server`, OpenAI-compatible). No API key unless you set --api-key. Fetch models to import what's loaded.",
    fallbackContextWindow: DEFAULT_EXTRA_PROVIDER_CONTEXT,
    includeUsage: false,
    models: [],
  },
  {
    id: 'jan',
    label: 'Jan',
    prefix: 'jan:',
    baseUrl: 'http://localhost:1337/v1',
    builtin: true,
    local: true,
    keyLabel: 'Jan API key',
    keyPlaceholder: 'usually none',
    keyHint:
      'Local Jan server (OpenAI-compatible). Enable the local API server in Jan, then Fetch models.',
    fallbackContextWindow: DEFAULT_EXTRA_PROVIDER_CONTEXT,
    includeUsage: false,
    models: [],
  },
  {
    id: 'vllm',
    label: 'vLLM',
    prefix: 'vllm:',
    baseUrl: 'http://localhost:8000/v1',
    builtin: true,
    local: true,
    keyLabel: 'vLLM API key',
    keyPlaceholder: 'usually none',
    keyHint:
      'Self-hosted vLLM server (OpenAI-compatible). No API key unless you set --api-key. Fetch models to import the served model.',
    fallbackContextWindow: DEFAULT_EXTRA_PROVIDER_CONTEXT,
    includeUsage: false,
    models: [],
  },
]

export const BUILTIN_EXTRA_PROVIDER_SLUGS: readonly string[] = BUILTIN_EXTRA_PROVIDERS.map(
  (p) => p.id,
)
const BUILTIN_BY_SLUG = new Map(BUILTIN_EXTRA_PROVIDERS.map((p) => [p.id, p]))

// Prefixes that look like `<slug>:<id>` but are NOT extra providers, so model
// classification can stay list-free (works in synchronous renderer paths).
const NON_EXTRA_PREFIXES: readonly string[] = [
  OPENROUTER_MODEL_PREFIX,
  'lmstudio:',
  REMOTE_AGENT_MODEL_PREFIX,
]
const SLUG_RE = /^[a-z0-9-]+$/

/** The slug of an extra-provider selection, or `null` for any other model. */
export function extraProviderSlugFromModel(model: string): string | null {
  const colon = model.indexOf(':')
  if (colon <= 0) return null
  const slug = model.slice(0, colon)
  if (!SLUG_RE.test(slug)) return null
  if (NON_EXTRA_PREFIXES.includes(`${slug}:`)) return null
  return slug
}

export function isExtraProviderModel(model: string): boolean {
  return extraProviderSlugFromModel(model) !== null
}

/** Strip the provider slug to get the upstream model id. */
export function extraProviderModelId(model: string): string {
  const slug = extraProviderSlugFromModel(model)
  return slug ? model.slice(slug.length + 1) : model
}

/** Encode an upstream model id as a Copse model selection for `slug`. */
export function toExtraProviderModel(slug: string, modelId: string): string {
  return `${slug}:${modelId}`
}

/** The provider in `providers` that owns `model`'s slug, or `null`. */
export function extraProviderForModel(
  providers: readonly ExtraProvider[],
  model: string,
): ExtraProvider | null {
  const slug = extraProviderSlugFromModel(model)
  if (!slug) return null
  return providers.find((p) => p.id === slug) ?? null
}

/**
 * Display label for an extra-provider selection: the curated model label when
 * the provider list is available and knows the model, else the raw upstream id.
 * Passing no list (or an unknown model) degrades to the stripped model id.
 */
export function extraProviderDisplayLabel(
  model: string,
  providers: readonly ExtraProvider[] = [],
): string {
  const slug = extraProviderSlugFromModel(model)
  if (!slug) return model
  const id = model.slice(slug.length + 1)
  const provider = providers.find((p) => p.id === slug)
  return provider?.models.find((m) => m.id === id)?.label ?? id
}

/**
 * Context window for an extra-provider selection: the model's own size, else the
 * provider's fallback, else `null` (caller applies the global default). Resolution
 * order is per-model override/known → per-provider fallback → caller default.
 */
export function extraProviderContextWindow(
  providers: readonly ExtraProvider[],
  model: string,
): number | null {
  const provider = extraProviderForModel(providers, model)
  if (!provider) return null
  const id = extraProviderModelId(model)
  const known = provider.models.find((m) => m.id === id)?.contextWindow
  return known ?? provider.fallbackContextWindow
}

/** Per-MTok USD pricing for an extra-provider model, when one was stored. */
export interface ExtraProviderPricing {
  inputPricePerMTok: number
  outputPricePerMTok: number
}

/**
 * Stored pricing for an extra-provider selection, or `null` when the provider
 * didn't report a rate (so the caller treats it as unpriced rather than free).
 */
export function extraProviderModelPricing(
  providers: readonly ExtraProvider[],
  model: string,
): ExtraProviderPricing | null {
  const provider = extraProviderForModel(providers, model)
  if (!provider) return null
  const id = extraProviderModelId(model)
  const known = provider.models.find((m) => m.id === id)
  if (!known || typeof known.inputPricePerMTok !== 'number') return null
  return {
    inputPricePerMTok: known.inputPricePerMTok,
    outputPricePerMTok: known.outputPricePerMTok ?? known.inputPricePerMTok,
  }
}

/**
 * A `model selection → pricing` map for every extra-provider model that carries
 * a rate, keyed by the `<slug>:<id>` selection string used in thread usage. The
 * cost estimator consults this for models absent from the static cloud catalog.
 */
export function extraProviderPricingMap(
  providers: readonly ExtraProvider[],
): Record<string, ExtraProviderPricing> {
  const out: Record<string, ExtraProviderPricing> = {}
  for (const provider of providers) {
    for (const m of provider.models) {
      if (typeof m.inputPricePerMTok !== 'number') continue
      out[toExtraProviderModel(provider.id, m.id)] = {
        inputPricePerMTok: m.inputPricePerMTok,
        outputPricePerMTok: m.outputPricePerMTok ?? m.inputPricePerMTok,
      }
    }
  }
  return out
}

function normalizeModels(models: unknown): ExtraProviderModel[] {
  if (!Array.isArray(models)) return []
  const out: ExtraProviderModel[] = []
  for (const raw of models) {
    if (!raw || typeof raw !== 'object') continue
    const id = (raw as ExtraProviderModel).id
    if (typeof id !== 'string' || !id.trim()) continue
    const label = (raw as ExtraProviderModel).label
    const contextWindow = (raw as ExtraProviderModel).contextWindow
    const inputPrice = (raw as ExtraProviderModel).inputPricePerMTok
    const outputPrice = (raw as ExtraProviderModel).outputPricePerMTok
    out.push({
      id: id.trim(),
      ...(typeof label === 'string' && label.trim() ? { label: label.trim() } : {}),
      ...(typeof contextWindow === 'number' && contextWindow > 0 ? { contextWindow } : {}),
      ...(typeof inputPrice === 'number' && inputPrice >= 0
        ? { inputPricePerMTok: inputPrice }
        : {}),
      ...(typeof outputPrice === 'number' && outputPrice >= 0
        ? { outputPricePerMTok: outputPrice }
        : {}),
    })
  }
  return out
}

function mergeBuiltin(base: ExtraProvider, override: StoredExtraProvider): ExtraProvider {
  const models = override.models ? normalizeModels(override.models) : null
  return {
    ...base,
    // label, baseUrl, envVar stay locked to the preset.
    ...(models && models.length ? { models } : {}),
    ...(typeof override.fallbackContextWindow === 'number' && override.fallbackContextWindow > 0
      ? { fallbackContextWindow: override.fallbackContextWindow }
      : {}),
    ...(typeof override.includeUsage === 'boolean' ? { includeUsage: override.includeUsage } : {}),
    ...(override.extraBody && typeof override.extraBody === 'object'
      ? { extraBody: override.extraBody }
      : {}),
    ...(typeof override.keyPrefix === 'string' ? { keyPrefix: override.keyPrefix } : {}),
  }
}

function customToProvider(stored: StoredExtraProvider): ExtraProvider | null {
  const slug = typeof stored.slug === 'string' ? stored.slug.trim() : ''
  const baseUrl = typeof stored.baseUrl === 'string' ? stored.baseUrl.trim() : ''
  if (!SLUG_RE.test(slug) || !baseUrl) return null
  const label = (typeof stored.label === 'string' && stored.label.trim()) || slug
  return {
    id: slug,
    label,
    prefix: `${slug}:`,
    baseUrl,
    builtin: false,
    local: isLocalBaseUrl(baseUrl),
    keyLabel: `${label} API key`,
    keyPlaceholder: 'API key',
    keyHint: `For ${label} (OpenAI-compatible). Validated via a models request.`,
    ...(typeof stored.keyPrefix === 'string' && stored.keyPrefix
      ? { keyPrefix: stored.keyPrefix }
      : {}),
    fallbackContextWindow:
      typeof stored.fallbackContextWindow === 'number' && stored.fallbackContextWindow > 0
        ? stored.fallbackContextWindow
        : DEFAULT_EXTRA_PROVIDER_CONTEXT,
    ...(typeof stored.includeUsage === 'boolean' ? { includeUsage: stored.includeUsage } : {}),
    ...(stored.extraBody && typeof stored.extraBody === 'object'
      ? { extraBody: stored.extraBody }
      : {}),
    models: normalizeModels(stored.models),
  }
}

/**
 * Merge the shipped presets with the user's stored overrides/customs into the
 * effective provider list: presets first (with editable fields merged in), then
 * user-added providers in stored order. Malformed records are skipped.
 */
export function resolveExtraProviders(
  stored: readonly StoredExtraProvider[] | undefined | null,
): ExtraProvider[] {
  const overrides = new Map<string, StoredExtraProvider>()
  const customs: StoredExtraProvider[] = []
  for (const s of stored ?? []) {
    // `stored` is persisted/external data typed as StoredExtraProvider[]; a null
    // or malformed entry is still possible at runtime, so guard defensively.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!s || typeof s.slug !== 'string') continue
    if (BUILTIN_BY_SLUG.has(s.slug)) overrides.set(s.slug, s)
    else customs.push(s)
  }

  const out: ExtraProvider[] = BUILTIN_EXTRA_PROVIDERS.map((base) => {
    const override = overrides.get(base.id)
    return override ? mergeBuiltin(base, override) : base
  })

  const seen = new Set(out.map((p) => p.id))
  for (const s of customs) {
    const provider = customToProvider(s)
    if (!provider || seen.has(provider.id)) continue
    seen.add(provider.id)
    out.push(provider)
  }
  return out
}
