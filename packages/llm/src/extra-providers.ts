// OpenAI-compatible "extra" providers offered alongside OpenRouter. The app
// ships a few curated presets (Mistral, Google Gemini, DeepSeek) and lets the
// user add as many more OpenAI-compatible endpoints as they like. Most speak
// the OpenAI Chat Completions API; a preset may opt into the Responses API when
// its endpoint uses that protocol (see create-provider.ts).
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
//
// The preset catalog is data, not code: it lives in
// `packages/llm/data/provider-metadata.json` and reaches this module through
// provider-metadata.ts, which validates it at load. Adding a provider is a JSON
// edit; only a dialect that needs new wire handling in create-provider.ts
// touches TypeScript.

import { isSafeCredentialBaseUrl } from './credential-url.ts'
import { PROVIDER_PRESETS } from './provider-metadata.ts'
import { isProviderSlug, parseModelSelection } from './model-selection.ts'
import { blendedRate } from './pareto-frontier.ts'
import type { ModelPricing, ModelPricingMap } from './model-pricing.ts'

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
  /** Context window (tokens) used for history trimming; falls back per provider. */
  contextWindow?: number
  /** USD per million input tokens, when the provider reports a rate (e.g. HF router). */
  inputPricePerMTok?: number
  /** USD per million output tokens, when the provider reports a rate. */
  outputPricePerMTok?: number
  /** 80/20 blended price (0.8 * input + 0.2 * output), pre-calculated for comparison. */
  blendedCostPerMTok?: number
}

/**
 * Display label for an extra-provider selection: the upstream model id, with
 * the routing slug stripped.
 *
 * #1241 reduced this to the upstream id when it dropped the curated per-model
 * labels, but returned the whole selection instead — so every surface rendered
 * `groq:llama-3.3-70b`, the routing prefix and all, next to house-styled names
 * like "Claude Opus 4.8". The slug says which endpoint Copse asks; it is not
 * part of the model's name, and the picker already groups by provider.
 *
 * The id itself is left verbatim — it is what the endpoint is asked for, org
 * path included (`zai-org/GLM-5.2:deepinfra`) — the same identity contract
 * `openRouterDisplayLabel` keeps for an uncurated id.
 */
export function extraProviderDisplayLabel(
  model: string,
  _providers: readonly ExtraProvider[] = [],
): string {
  return extraProviderModelId(model)
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
  /** Wire protocol used by the provider. Defaults to Chat Completions. */
  apiStyle?: 'chat-completions' | 'responses'
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

/**
 * The shipped presets, in picker order. The catalog itself lives in
 * `packages/llm/data/provider-metadata.json` (see provider-metadata.ts);
 * only the three derived fields are applied here. `local` in particular is
 * computed from the base URL rather than read from data, so no catalog edit can
 * declare a remote endpoint local and skip the "data leaves this machine"
 * treatment in Settings.
 */
export const BUILTIN_EXTRA_PROVIDERS: readonly ExtraProvider[] = PROVIDER_PRESETS.map((preset) => ({
  ...preset,
  prefix: `${preset.id}:`,
  builtin: true,
  local: isLocalBaseUrl(preset.baseUrl),
}))

export const BUILTIN_EXTRA_PROVIDER_SLUGS: readonly string[] = BUILTIN_EXTRA_PROVIDERS.map(
  (p) => p.id,
)
const BUILTIN_BY_SLUG = new Map(BUILTIN_EXTRA_PROVIDERS.map((p) => [p.id, p]))

// Which `<slug>:<id>` selections are extra providers — and which are one of the
// reserved namespaces wearing the same shape — is decided by the shared parser,
// so a new namespace is taught to `model-selection.ts` alone. Classification
// stays list-free and synchronous, which the renderer paths need.

/** The slug of an extra-provider selection, or `null` for any other model. */
export function extraProviderSlugFromModel(model: string): string | null {
  const selection = parseModelSelection(model)
  return selection.namespace === 'extra-provider' ? selection.slug : null
}

export function isExtraProviderModel(model: string): boolean {
  return extraProviderSlugFromModel(model) !== null
}

/** Strip the provider slug to get the upstream model id. */
export function extraProviderModelId(model: string): string {
  const selection = parseModelSelection(model)
  // `id`, not `modelId`: an endpoint that addresses models as `vendor/model`
  // expects that whole string back on the wire.
  return selection.namespace === 'extra-provider' ? selection.id : model
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

/**
 * Stored pricing for an extra-provider selection, or `null` when the provider
 * didn't report a rate (so the caller treats it as unpriced rather than free).
 */
export function extraProviderModelPricing(
  providers: readonly ExtraProvider[],
  model: string,
): ModelPricing | null {
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
 * a rate, keyed by the `<slug>:<id>` selection string used in thread usage. One
 * of the sources merged into the estimator's pricing map (see model-pricing.ts).
 */
export function extraProviderPricingMap(providers: readonly ExtraProvider[]): ModelPricingMap {
  const out: ModelPricingMap = {}
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
  const values: unknown[] = models
  for (const raw of values) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const id = 'id' in raw ? raw.id : undefined
    if (typeof id !== 'string' || !id.trim()) continue
    const contextWindow = 'contextWindow' in raw ? raw.contextWindow : undefined
    const inputPrice = 'inputPricePerMTok' in raw ? raw.inputPricePerMTok : undefined
    const outputPrice = 'outputPricePerMTok' in raw ? raw.outputPricePerMTok : undefined
    const entry: ExtraProviderModel = {
      id: id.trim(),
      ...(typeof contextWindow === 'number' && contextWindow > 0 ? { contextWindow } : {}),
      ...(typeof inputPrice === 'number' && inputPrice >= 0
        ? { inputPricePerMTok: inputPrice }
        : {}),
      ...(typeof outputPrice === 'number' && outputPrice >= 0
        ? { outputPricePerMTok: outputPrice }
        : {}),
    }
    if (
      typeof entry.inputPricePerMTok === 'number' &&
      typeof entry.outputPricePerMTok === 'number'
    ) {
      entry.blendedCostPerMTok = blendedRate(entry.inputPricePerMTok, entry.outputPricePerMTok)
    }
    out.push(entry)
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
  if (!isProviderSlug(slug) || !baseUrl) return null
  // Fail closed: a base URL carries the provider's API key, so a tampered or
  // synced settings.json that bypasses the write-time schema must not resurrect
  // a custom provider pointing the key at an unsafe host. See credential-url.ts.
  if (!isSafeCredentialBaseUrl(baseUrl)) return null
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
