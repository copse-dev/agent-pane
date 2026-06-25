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

export interface ExtraProviderModel {
  /** Upstream model id sent to the provider. */
  id: string
  /** Human label shown in the picker (defaults to the id). */
  label?: string
  /** Context window (tokens) used for history trimming; falls back per provider. */
  contextWindow?: number
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
    envVar: 'MISTRAL_API_KEY',
    keyLabel: 'Mistral API key',
    keyPlaceholder: 'Mistral API key',
    keyHint:
      "For Mistral models on La Plateforme's free Experiment tier. Validated via a free models request.",
    fallbackContextWindow: MISTRAL_CONTEXT,
    includeUsage: true,
    models: [
      { id: 'mistral-small-latest', label: 'Mistral Small (free tier)', contextWindow: MISTRAL_CONTEXT },
      { id: 'open-mistral-nemo', label: 'Mistral Nemo (free tier)', contextWindow: MISTRAL_CONTEXT },
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
    envVar: 'GEMINI_API_KEY',
    keyLabel: 'Google Gemini API key',
    keyPlaceholder: 'AIza…',
    keyHint:
      'For Gemini Flash models on the free tier (rate-limited, no card). Get a key at aistudio.google.com.',
    keyPrefix: 'AIza',
    fallbackContextWindow: GEMINI_CONTEXT,
    includeUsage: true,
    models: [
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (free tier)', contextWindow: GEMINI_CONTEXT },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite (free tier)', contextWindow: GEMINI_CONTEXT },
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (free tier)', contextWindow: GEMINI_CONTEXT },
      { id: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash-Lite (free tier)', contextWindow: GEMINI_CONTEXT },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    prefix: 'deepseek:',
    baseUrl: 'https://api.deepseek.com',
    builtin: true,
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
    models: [{ id: 'deepseek-chat', label: 'DeepSeek V3 (deepseek-chat)', contextWindow: DEEPSEEK_CONTEXT }],
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
  return known ?? provider.fallbackContextWindow ?? DEFAULT_EXTRA_PROVIDER_CONTEXT
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
    out.push({
      id: id.trim(),
      ...(typeof label === 'string' && label.trim() ? { label: label.trim() } : {}),
      ...(typeof contextWindow === 'number' && contextWindow > 0 ? { contextWindow } : {}),
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
    keyLabel: `${label} API key`,
    keyPlaceholder: 'API key',
    keyHint: `For ${label} (OpenAI-compatible). Validated via a models request.`,
    ...(typeof stored.keyPrefix === 'string' && stored.keyPrefix ? { keyPrefix: stored.keyPrefix } : {}),
    fallbackContextWindow:
      typeof stored.fallbackContextWindow === 'number' && stored.fallbackContextWindow > 0
        ? stored.fallbackContextWindow
        : DEFAULT_EXTRA_PROVIDER_CONTEXT,
    ...(typeof stored.includeUsage === 'boolean' ? { includeUsage: stored.includeUsage } : {}),
    ...(stored.extraBody && typeof stored.extraBody === 'object' ? { extraBody: stored.extraBody } : {}),
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
