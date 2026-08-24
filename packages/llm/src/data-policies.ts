// Per-provider data-retention / training policies, so the UI can highlight
// where prompts go after they leave the device (Settings badges, model-picker
// annotations) and docs/provider-data-policies.md can stay in sync with code.
//
// The table itself lives in `packages/llm/data/provider-metadata.json` alongside
// the provider presets — one file to edit when a provider is added or its policy
// changes. This module owns only the resolution rules: slug first, then API
// hostname, plus the OpenRouter variants that depend on Copse's own routing
// settings rather than on a provider fact.
//
// Every entry is hand-verified against the provider's own documentation — the
// primary source is recorded in `policyUrl` and the verification date in
// LAST_VERIFIED. These describe DEFAULT behavior for the API tier Copse
// integrates (e.g. Gemini/Mistral entries reflect the free tiers the presets
// advertise). A provider can offer stricter arrangements (enterprise ZDR
// contracts etc.); `zdr` records how to get there.
//
// provider-metadata.test.ts fails the suite if a non-local preset has no policy,
// and data-policies.test.ts enforces coverage of the built-ins and of the fixed
// cloud providers (create-provider.ts) and known-endpoint prefills
// (custom-providers-section.ts).

import { PROVIDER_DATA_POLICIES, PROVIDER_METADATA_LAST_VERIFIED } from './provider-metadata.ts'

/** When the entries below were last checked against the linked sources. */
export const DATA_POLICIES_LAST_VERIFIED = PROVIDER_METADATA_LAST_VERIFIED

export interface ProviderDataPolicy {
  /**
   * Prompts/completions are retained at rest by default. `null` = unknown or
   * depends on a third party (e.g. Hugging Face's routed partners).
   */
  retainsPrompts: boolean | null
  /** Stated retention window in days, when the provider publishes one. */
  retentionDays?: number
  /**
   * Inputs/outputs may be used to train or improve models by default. `null` =
   * unknown / partner-dependent.
   */
  trainsOnData: boolean | null
  /**
   * How zero-data-retention can be achieved with this provider:
   * - `default`   — ZDR is the provider's default behavior
   * - `request`   — a per-request parameter or self-serve program enables it
   * - `setting`   — an account/console toggle enables it
   * - `contract`  — only via a sales/enterprise arrangement
   * - `none`      — no documented ZDR path
   * - `unknown`   — not determinable (e.g. depends on a routed partner)
   */
  zdr: 'default' | 'request' | 'setting' | 'contract' | 'none' | 'unknown'
  /** One-line summary shown as a Settings hint. */
  note: string
  /** Primary source (provider's own docs/policy). */
  policyUrl: string
}

// Both lookups are built from the same catalog entries, so a policy shared by a
// slug and its API hostname stays a single object. A slug-less entry is
// host-only on purpose (see the `api.x.ai` note in the catalog): adding a slug
// would change which branch of `dataPolicyForModelPath` claims a model id.
const POLICIES_BY_SLUG: Record<string, ProviderDataPolicy> = {}
const POLICIES_BY_HOST: Record<string, ProviderDataPolicy> = {}
for (const { slugs, hosts, ...policy } of PROVIDER_DATA_POLICIES) {
  for (const slug of slugs) POLICIES_BY_SLUG[slug] = policy
  for (const host of hosts ?? []) POLICIES_BY_HOST[host] = policy
}

function hostFromBaseUrl(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null
  try {
    return new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * The data policy for a provider, resolved by slug first (fixed providers and
 * built-in presets) and then by API hostname (known-endpoint customs). `null`
 * when the provider is unrecognized — callers should treat that as unknown,
 * not as safe.
 */
export function dataPolicyForProvider(provider: {
  id: string
  baseUrl?: string
}): ProviderDataPolicy | null {
  const bySlug = POLICIES_BY_SLUG[provider.id]
  if (bySlug) return bySlug
  const host = hostFromBaseUrl(provider.baseUrl)
  if (host) {
    const byHost = POLICIES_BY_HOST[host]
    if (byHost) return byHost
  }
  return null
}

/**
 * OpenRouter's effective policy depends on Copse's routing settings:
 * `openRouterZdrOnly` (default on) restricts routing to zero-data-retention
 * endpoints, and `openRouterAllowTraining` (default off) controls whether
 * `data_collection: "deny"` is sent. Retention and training are separate
 * OpenRouter policy axes, so relaxing ZDR does not by itself re-admit
 * providers that train — only the explicit allow-training opt-in does.
 */
export function openRouterDataPolicy(zdrOnly: boolean, allowTraining = false): ProviderDataPolicy {
  // ZDR endpoints cannot train ("Providers that do not retain your data are
  // also unable to train on your data" — OpenRouter ZDR docs), so ZDR-only
  // routing yields the zero-retention policy regardless of the training flag.
  if (zdrOnly) {
    const policy = POLICIES_BY_SLUG['openrouter']
    if (!policy) throw new Error('OpenRouter data policy is missing')
    return policy
  }
  if (allowTraining) {
    return {
      retainsPrompts: null,
      trainsOnData: true,
      zdr: 'request',
      note: 'ZDR-only routing is OFF and may-train providers are allowed: requests can be routed to upstream endpoints that retain prompts and use them for training (common for free models).',
      policyUrl: 'https://openrouter.ai/docs/guides/features/zdr',
    }
  }
  return {
    retainsPrompts: null,
    trainsOnData: false,
    zdr: 'request',
    note: 'ZDR-only routing is OFF: upstream endpoints may retain prompts under their own policies, but data_collection:"deny" still excludes providers that train on or store inputs.',
    policyUrl: 'https://openrouter.ai/docs/guides/features/zdr',
  }
}

export type PrivacyBadgeKind = 'local' | 'zdr' | 'no-training' | 'trains' | 'unknown'

export interface PrivacyBadge {
  kind: PrivacyBadgeKind
  /** Short label for a Settings badge. */
  label: string
}

/**
 * Compress a policy into the badge the Settings UI shows next to a provider.
 * Local providers short-circuit (data never leaves the machine); an unknown
 * policy is surfaced as unknown rather than hidden, so silence never reads as
 * an endorsement.
 */
export function privacyBadge(
  policy: ProviderDataPolicy | null,
  opts: { local?: boolean } = {},
): PrivacyBadge {
  if (opts.local) return { kind: 'local', label: 'Local — data stays on this machine' }
  if (!policy) return { kind: 'unknown', label: 'Data policy unknown' }
  if (policy.trainsOnData) return { kind: 'trains', label: 'May train on your data' }
  if (policy.trainsOnData === null || policy.retainsPrompts === null) {
    return { kind: 'unknown', label: 'Retention varies / unknown' }
  }
  if (!policy.retainsPrompts) return { kind: 'zdr', label: 'Zero data retention' }
  return {
    kind: 'no-training',
    label: policy.retentionDays
      ? `No training — retained ≤${String(policy.retentionDays)} days`
      : 'No training — retained',
  }
}

/**
 * Short annotation for the model picker's provider group heading, or `null`
 * when the provider needs no flag (ZDR / no-training / local). Only the two
 * caution cases are surfaced so the picker stays quiet by default.
 */
export function pickerPrivacyNote(policy: ProviderDataPolicy | null): string | null {
  if (!policy) return null
  if (policy.trainsOnData) return 'may train on your data'
  if (policy.trainsOnData === null || policy.retainsPrompts === null) {
    return 'retention varies by provider'
  }
  return null
}

/** Minimal provider shape needed to resolve a model id's retention path. */
export interface ModelPathProvider {
  id: string
  baseUrl?: string
  local?: boolean
  /** Model-selection prefix, usually `${id}:`. */
  prefix?: string
}

export interface ModelPathPolicyOptions {
  /** Effective OpenRouter routing settings; omitted values use Copse defaults. */
  openRouterZdrOnly?: boolean
  openRouterAllowTraining?: boolean
}

/**
 * Resolve the data-retention policy for a model *path* (how Copse would reach
 * it), not just the model weights. Local / loopback paths short-circuit;
 * `huggingface:org/model:partner` uses the partner's policy when known;
 * bare cloud ids use Anthropic/OpenAI/xAI defaults. Unknown paths return
 * `{ policy: null, local: false }` — never treated as safe.
 */
export function dataPolicyForModelPath(
  modelId: string,
  providers: readonly ModelPathProvider[] = [],
  opts: ModelPathPolicyOptions = {},
): { policy: ProviderDataPolicy | null; local: boolean } {
  const id = modelId.trim()
  if (id.length === 0) return { policy: null, local: false }
  if (id.startsWith('lmstudio:')) return { policy: null, local: true }

  for (const provider of providers) {
    const prefix = provider.prefix ?? `${provider.id}:`
    if (!id.startsWith(prefix)) continue
    if (provider.local) return { policy: null, local: true }
    return {
      policy: dataPolicyForProvider({
        id: provider.id,
        ...(provider.baseUrl !== undefined ? { baseUrl: provider.baseUrl } : {}),
      }),
      local: false,
    }
  }

  // Serving-route tag on a vendor path: `huggingface:org/model:together`.
  // Checked before the outer slug so HF's partner-dependent policy does not
  // shadow a known ZDR partner pin.
  const lastColon = id.lastIndexOf(':')
  if (lastColon > 0 && id.slice(0, lastColon).includes('/')) {
    const partner = id.slice(lastColon + 1)
    const byPartner = dataPolicyForProvider({ id: partner })
    if (byPartner) return { policy: byPartner, local: false }
    if (id.startsWith('huggingface:')) {
      return { policy: dataPolicyForProvider({ id: 'huggingface' }), local: false }
    }
  }

  // Known slug prefixes (fireworks:, together:, groq:, …) even when that
  // extra provider isn't in the caller's configured list.
  const sep = id.indexOf(':')
  if (sep > 0 && !id.slice(0, sep).includes('/')) {
    const slug = id.slice(0, sep)
    if (slug === 'openrouter') {
      return {
        policy: openRouterDataPolicy(
          opts.openRouterZdrOnly !== false,
          opts.openRouterAllowTraining === true,
        ),
        local: false,
      }
    }
    const bySlug = dataPolicyForProvider({ id: slug })
    if (bySlug) return { policy: bySlug, local: false }
  }

  if (id.startsWith('claude')) {
    return { policy: dataPolicyForProvider({ id: 'anthropic' }), local: false }
  }
  if (id.startsWith('gpt')) {
    return { policy: dataPolicyForProvider({ id: 'openai' }), local: false }
  }
  if (id.toLowerCase().includes('grok')) {
    return {
      policy: dataPolicyForProvider({ id: 'xai', baseUrl: 'https://api.x.ai/v1' }),
      local: false,
    }
  }
  return { policy: null, local: false }
}

/**
 * True when the model can be reached on a zero-data-retention path under the
 * same rules as Settings privacy badges (`zdr` or `local`). Matches the green
 * "Zero data retention" badge — not "ZDR available via enterprise contract".
 */
export function isZeroRetentionModelPath(
  modelId: string,
  opts: {
    local?: boolean
    providers?: readonly ModelPathProvider[]
    openRouterZdrOnly?: boolean
    openRouterAllowTraining?: boolean
  } = {},
): boolean {
  if (opts.local) return true
  const resolved = dataPolicyForModelPath(modelId, opts.providers ?? [], opts)
  const kind = privacyBadge(resolved.policy, { local: resolved.local }).kind
  return kind === 'zdr' || kind === 'local'
}

/**
 * True only for a route that is known not to train on prompts: local, ZDR, or
 * retained-but-no-training. Unknown/partner-dependent routes fail closed.
 */
export function isNoTrainingModelPath(
  modelId: string,
  opts: {
    local?: boolean
    providers?: readonly ModelPathProvider[]
    openRouterZdrOnly?: boolean
    openRouterAllowTraining?: boolean
  } = {},
): boolean {
  if (opts.local) return true
  const resolved = dataPolicyForModelPath(modelId, opts.providers ?? [], opts)
  return resolved.local || resolved.policy?.trainsOnData === false
}
