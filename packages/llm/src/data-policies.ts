// Per-provider data-retention / training policies, so the UI can highlight
// where prompts go after they leave the device (Settings badges, model-picker
// annotations) and docs/provider-data-policies.md can stay in sync with code.
//
// Every entry is hand-verified against the provider's own documentation — the
// primary source is recorded in `policyUrl` and the verification date in
// LAST_VERIFIED. These describe DEFAULT behavior for the API tier Copse
// integrates (e.g. Gemini/Mistral entries reflect the free tiers the presets
// advertise). A provider can offer stricter arrangements (enterprise ZDR
// contracts etc.); `zdr` records how to get there.
//
// Keep this table in sync with BUILTIN_EXTRA_PROVIDERS (extra-providers.ts),
// the fixed cloud providers (create-provider.ts), and the known-endpoint
// prefills (custom-providers-section.ts). data-policies.test.ts enforces
// coverage of the built-ins.

/** When the entries below were last checked against the linked sources. */
export const DATA_POLICIES_LAST_VERIFIED = '2026-07-19'

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

const TOGETHER_POLICY: ProviderDataPolicy = {
  retainsPrompts: false,
  trainsOnData: false,
  zdr: 'setting',
  note: 'Together does not store inputs/outputs by default; training use is opt-in. Confirm the org-level privacy setting answers “No” to storing prompts.',
  policyUrl: 'https://docs.together.ai/docs/privacy-and-security',
}

const GROQ_POLICY: ProviderDataPolicy = {
  retainsPrompts: true,
  retentionDays: 30,
  trainsOnData: false,
  zdr: 'setting',
  note: 'Groq may temporarily log inference data for reliability and abuse prevention for up to 30 days unless Zero Data Retention is enabled in console Data Controls.',
  policyUrl: 'https://console.groq.com/docs/your-data',
}

const FIREWORKS_POLICY: ProviderDataPolicy = {
  retainsPrompts: false,
  trainsOnData: false,
  zdr: 'default',
  note: 'Fireworks does not log or store prompts/generations for open models without explicit opt-in; data lives only in volatile memory for the request.',
  policyUrl: 'https://docs.fireworks.ai/guides/security_compliance/data_handling',
}

// Fixed cloud providers + built-in OpenAI-compatible presets, keyed by slug.
const POLICIES_BY_SLUG: Record<string, ProviderDataPolicy> = {
  anthropic: {
    retainsPrompts: true,
    retentionDays: 30,
    trainsOnData: false,
    zdr: 'contract',
    note: 'No training on API data. Inputs/outputs deleted within ~30 days; zero-data-retention is an enterprise arrangement via sales.',
    policyUrl: 'https://platform.claude.com/docs/en/manage-claude/api-and-data-retention',
  },
  openai: {
    retainsPrompts: true,
    retentionDays: 30,
    trainsOnData: false,
    zdr: 'contract',
    note: 'No training on API data. Abuse-monitoring logs kept up to 30 days; Copse sends store:false so responses are not additionally stored. ZDR requires OpenAI approval.',
    policyUrl: 'https://platform.openai.com/docs/guides/your-data',
  },
  openrouter: {
    retainsPrompts: false,
    trainsOnData: false,
    zdr: 'request',
    note: 'OpenRouter itself keeps no prompts. Copse requests ZDR routing by default (provider.zdr + data_collection:"deny"), so only zero-retention, non-training upstreams are used.',
    policyUrl: 'https://openrouter.ai/docs/guides/features/zdr',
  },
  mistral: {
    retainsPrompts: true,
    retentionDays: 30,
    trainsOnData: true,
    zdr: 'contract',
    note: 'Free/Pro plan API data may be used to improve Mistral models unless you opt out (Admin Console → Privacy). 30-day rolling retention; ZDR is Scale-plan only.',
    policyUrl:
      'https://help.mistral.ai/en/articles/455207-can-i-opt-out-of-my-input-or-output-data-being-used-for-training',
  },
  gemini: {
    retainsPrompts: true,
    trainsOnData: true,
    zdr: 'request',
    note: 'On the free tier Google may use prompts/responses to improve its products (including human review). Paid-tier data is kept ~55 days for abuse detection only.',
    policyUrl: 'https://ai.google.dev/gemini-api/terms',
  },
  deepseek: {
    retainsPrompts: true,
    trainsOnData: true,
    zdr: 'none',
    note: 'Data is stored in China for as long as necessary and may be used to improve the service. Opt-out is by request (privacy@deepseek.com); no documented ZDR.',
    policyUrl: 'https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html',
  },
  huggingface: {
    retainsPrompts: null,
    trainsOnData: null,
    zdr: 'unknown',
    note: 'Hugging Face does not store request/response bodies (30-day debug logs only), but requests are routed to third-party partners (Together, Fireworks, Novita, …) who each apply their OWN retention and training policy.',
    policyUrl: 'https://huggingface.co/docs/inference-providers/security',
  },
  perplexity: {
    retainsPrompts: null,
    trainsOnData: null,
    zdr: 'unknown',
    note: 'Perplexity’s API FAQ says query data is not retained or used for training, but its dedicated zero-retention page currently names Sonar API only and does not explicitly cover Agent API.',
    policyUrl: 'https://docs.perplexity.ai/docs/resources/faq',
  },
  together: TOGETHER_POLICY,
  groq: GROQ_POLICY,
  fireworks: FIREWORKS_POLICY,
}

// Recognized custom endpoints, keyed by API hostname. The built-in ZDR
// providers are repeated here so an existing custom slug for the same official
// endpoint still receives the correct policy badge.
const POLICIES_BY_HOST: Record<string, ProviderDataPolicy> = {
  'api.together.xyz': TOGETHER_POLICY,
  'api.groq.com': GROQ_POLICY,
  'api.fireworks.ai': FIREWORKS_POLICY,
  'api.x.ai': {
    retainsPrompts: true,
    retentionDays: 30,
    trainsOnData: false,
    zdr: 'setting',
    note: 'xAI stores API requests/responses encrypted for 30 days (abuse auditing) and never trains on them; a team-level ZDR setting removes retention entirely.',
    policyUrl: 'https://docs.x.ai/developers/faq/security',
  },
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
  if (zdrOnly) return POLICIES_BY_SLUG['openrouter'] as ProviderDataPolicy
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
