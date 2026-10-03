// The one place a model id string is matched against a known family.
//
// Routing used to be decided by `startsWith('gpt')` scattered across the app —
// provider family in create-provider, agent-service and provider-selection, the
// Responses-API prefix list in its own file, operator-instruction placement in
// the catalog. Each copy answered a slightly different question with a slightly
// different match, and a new gpt-named model silently took whichever path the
// nearest prefix implied. This module replaces them with a data table plus one
// resolver; `scripts/model-id-routing.test.ts` fails when the pattern comes back
// anywhere else.
//
// It is a leaf (imports only the selection parser) so that `model-catalog.ts` and
// `model-parameters.ts` can use it without the cycle `model-capabilities.ts` —
// the public lookup, which also needs both — would create. Application code
// should call `modelCapabilities` from `model-capabilities.ts`.
//
// ## How an id resolves
//
// 1. The selection is parsed (`parseModelSelection`); the *namespace* decides the
//    transport. Only a bare cloud id is ever a first-party route. OpenRouter and
//    extra providers reach `gpt-5` through their own endpoints and never inherit
//    the Responses API; `lmstudio:` serves local weights; the agent namespaces
//    are routed by the host.
// 2. For the cloud-routed namespaces (`cloud`, `openrouter`, `extra-provider`)
//    the vendor-stripped `modelId` is matched against `FAMILIES`, longest entry
//    first. An entry matches on a *boundary* — the id itself, or the entry
//    followed by `-`, `.`, `:` or `@` — so dated snapshots (`gpt-5.6-sol-2026-07-01`),
//    sub-variants (`gpt-5-mini`) and aggregator suffixes (`claude-opus-5:beta`)
//    resolve, while `gpt-50` and `o1x-turbo` do not.
// 3. An id matching no entry but carrying a first-party *prefix* (`gpt-`,
//    `claude-`) is still routed to that provider — a user's key for it is the only
//    place it can go — but as an UNKNOWN model: `known: false`, the provider's
//    conservative transport, and no optional capability. Never "it looks like gpt,
//    so assume everything it might do".
//
// ## Two kinds of flag
//
// *API* flags (`supportsStrictTools`, `supportsVerbosity`,
// `supportsParallelToolCallsControl`, `supportsServerCompaction`) say whether the
// request Copse sends to *this route* may carry the field. They are therefore
// only ever true for a direct first-party route: `openrouter:openai/gpt-5` does
// not get `text.verbosity` just because GPT-5 has it.
//
// *Lineage* flags (`prefersApplyPatch`, `acceptsDeveloperRole`,
// `acceptsMidConversationSystem`) describe how the *model* behaves wherever it is
// served, so they follow the vendor-stripped id in every cloud-routed namespace —
// that is what operator-instruction placement and prompt profiles have always done.
//
// ## Maintaining the table
//
// Values are what the vendor documents for the family. A flag is only `true`
// when something reviewed it; when in doubt leave it off — a missing capability
// costs a feature, a wrong one is a 400. `supportsServerCompaction` is off for
// every family: no code consumes it yet, and the thread that does should flip it
// for the families it verifies, in the same PR.

import { parseModelSelection, type ModelNamespace, type ModelSelection } from './model-selection.ts'

/** The wire a request to this selection takes. */
export type ModelTransport =
  /** Anthropic Messages API, direct. */
  | 'anthropic'
  /** OpenAI `/v1/responses`, direct. */
  | 'openai-responses'
  /** OpenAI `/v1/chat/completions`, direct. */
  | 'openai-chat'
  /** An OpenAI-shaped endpoint we do not own: OpenRouter or an extra provider. */
  | 'openai-compatible'
  /** A local OpenAI-compatible server (LM Studio). */
  | 'local'
  /** `acp:`, `remote-agent:`, `plugin-model:`, `auto:` — the host takes the branch. */
  | 'host-routed'
  /** An unprefixed id no family claims; routed by whichever cloud key exists. */
  | 'unknown'

/** The first-party provider a bare id is sent to. */
export type FirstPartyProvider = 'anthropic' | 'openai'

/** Model-behaviour flags, all off unless a family entry says otherwise. */
export interface ModelFeatures {
  /** The request may set `strict: true` on function tools. */
  readonly supportsStrictTools: boolean
  /** The request may set `text.verbosity`. */
  readonly supportsVerbosity: boolean
  /** The request may set `parallel_tool_calls` (either way). */
  readonly supportsParallelToolCallsControl: boolean
  /** The request may set `context_management` (server-side compaction). */
  readonly supportsServerCompaction: boolean
  /** The model is trained on the `apply_patch` tool and does better with it than with edit tools. */
  readonly prefersApplyPatch: boolean
  /** A `{ role: 'developer' }` message is accepted mid-conversation. */
  readonly acceptsDeveloperRole: boolean
  /** A `{ role: 'system' }` message is accepted *inside* `messages`. */
  readonly acceptsMidConversationSystem: boolean
}

const NO_FEATURES: ModelFeatures = {
  supportsStrictTools: false,
  supportsVerbosity: false,
  supportsParallelToolCallsControl: false,
  supportsServerCompaction: false,
  prefersApplyPatch: false,
  acceptsDeveloperRole: false,
  acceptsMidConversationSystem: false,
}

type FamilyTransport = Extract<ModelTransport, 'anthropic' | 'openai-responses' | 'openai-chat'>

interface FamilyEntry {
  /** Id prefix, matched on a boundary. Also the family's canonical key. */
  readonly match: string
  readonly provider: FirstPartyProvider
  /** The transport a direct first-party request takes. */
  readonly transport: FamilyTransport
  readonly features?: Partial<ModelFeatures>
}

// GPT-5 and later: the Responses API, which carries reasoning as its own output item
// and lets the model keep reasoning across a tool chain. Chat Completions has no
// reasoning field at all, so on that endpoint a reasoning model's thinking is simply
// not returned. Non-reasoning models (gpt-4o) gain nothing from the move and keep
// the well-exercised chat path. The reasoning list mirrors LLM 0.32's move to
// Responses (simonw/llm#1435) plus the gpt-5.6 family, GPT-6 Astra and GPT-6.1 Sol.
const GPT_REASONING_FEATURES: Partial<ModelFeatures> = {
  supportsStrictTools: true,
  supportsVerbosity: true,
  supportsParallelToolCallsControl: true,
  prefersApplyPatch: true,
  acceptsDeveloperRole: true,
}

// o-series: Responses API and the `developer` role, but no `text.verbosity`, and
// parallel tool calls are not uniformly documented across o1/o3/o4.
const O_SERIES_FEATURES: Partial<ModelFeatures> = {
  supportsStrictTools: true,
  acceptsDeveloperRole: true,
}

const CLAUDE_MID_SYSTEM: Partial<ModelFeatures> = { acceptsMidConversationSystem: true }

/**
 * Known families. Order is irrelevant: the longest matching entry wins, so a
 * specific entry (`gpt-oss`) can carve an exception out of a broad one.
 */
const FAMILIES: readonly FamilyEntry[] = [
  // Anthropic. Mid-conversation `system` messages: Opus 5 / 4.8, Fable 5, Mythos 5.
  // `claude-sonnet-5-5` — the default model — does not take one, so leading-system
  // placement is the common path, not an edge case.
  {
    match: 'claude-opus-5',
    provider: 'anthropic',
    transport: 'anthropic',
    features: CLAUDE_MID_SYSTEM,
  },
  {
    match: 'claude-opus-4-8',
    provider: 'anthropic',
    transport: 'anthropic',
    features: CLAUDE_MID_SYSTEM,
  },
  { match: 'claude-opus-4-7', provider: 'anthropic', transport: 'anthropic' },
  { match: 'claude-opus-4-6', provider: 'anthropic', transport: 'anthropic' },
  { match: 'claude-opus-4-5', provider: 'anthropic', transport: 'anthropic' },
  { match: 'claude-sonnet-5', provider: 'anthropic', transport: 'anthropic' },
  { match: 'claude-sonnet-4-6', provider: 'anthropic', transport: 'anthropic' },
  { match: 'claude-haiku-4-5', provider: 'anthropic', transport: 'anthropic' },
  {
    match: 'claude-fable-5',
    provider: 'anthropic',
    transport: 'anthropic',
    features: CLAUDE_MID_SYSTEM,
  },
  {
    match: 'claude-mythos-5',
    provider: 'anthropic',
    transport: 'anthropic',
    features: CLAUDE_MID_SYSTEM,
  },
  { match: 'claude-mythos-preview', provider: 'anthropic', transport: 'anthropic' },
  // OpenAI, Responses API.
  {
    match: 'gpt-5',
    provider: 'openai',
    transport: 'openai-responses',
    features: GPT_REASONING_FEATURES,
  },
  {
    match: 'gpt-6-astra',
    provider: 'openai',
    transport: 'openai-responses',
    features: GPT_REASONING_FEATURES,
  },
  {
    match: 'gpt-6.1-sol',
    provider: 'openai',
    transport: 'openai-responses',
    features: GPT_REASONING_FEATURES,
  },
  { match: 'o1', provider: 'openai', transport: 'openai-responses', features: O_SERIES_FEATURES },
  { match: 'o3', provider: 'openai', transport: 'openai-responses', features: O_SERIES_FEATURES },
  { match: 'o4', provider: 'openai', transport: 'openai-responses', features: O_SERIES_FEATURES },
  // OpenAI, Chat Completions: non-reasoning models gain nothing from Responses.
  {
    match: 'gpt-4o',
    provider: 'openai',
    transport: 'openai-chat',
    features: {
      supportsStrictTools: true,
      supportsParallelToolCallsControl: true,
      acceptsDeveloperRole: true,
    },
  },
  // Open-weights models OpenAI publishes. Not a first-party API model — it is
  // reached through aggregators or local servers, never `developer`-role aware —
  // and the entry exists to stop the broad `gpt-` fallback claiming its features.
  { match: 'gpt-oss', provider: 'openai', transport: 'openai-chat' },
]

/** Ids that carry a first-party prefix but match no entry: routed there, never trusted. */
const FIRST_PARTY_FALLBACKS: ReadonlyArray<{
  readonly prefix: string
  readonly provider: FirstPartyProvider
  readonly transport: FamilyTransport
}> = [
  { prefix: 'claude-', provider: 'anthropic', transport: 'anthropic' },
  { prefix: 'gpt-', provider: 'openai', transport: 'openai-chat' },
]

/** Characters that may follow a family key: `-` and `.` for variants, `:` and `@` for aggregator suffixes. */
const BOUNDARY = /^[-.:@]/

/** Whether `id` is `prefix` or a boundary-delimited extension of it. */
export function hasModelIdPrefix(id: string, prefix: string): boolean {
  return id === prefix || (id.startsWith(prefix) && BOUNDARY.test(id.slice(prefix.length)))
}

/** `gpt-5-2025-08-07` → `gpt-5`, `claude-x-20260101` → `claude-x`; other ids unchanged. */
export function undatedModelId(id: string): string {
  return id.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, '')
}

function findFamily(modelId: string): FamilyEntry | undefined {
  let best: FamilyEntry | undefined
  for (const entry of FAMILIES) {
    if (!hasModelIdPrefix(modelId, entry.match)) continue
    if (best === undefined || entry.match.length > best.match.length) best = entry
  }
  return best
}

/** Namespaces whose vendor-stripped id names a model whose lineage we can judge. */
const CLOUD_ROUTED: ReadonlySet<ModelNamespace> = new Set([
  'cloud',
  'openrouter',
  'extra-provider',
  'chatgpt-plan',
])

/** The routing and feature answer for one selection, before parameters and context are attached. */
export interface ModelFamilyResolution extends ModelFeatures {
  readonly namespace: ModelNamespace
  readonly transport: ModelTransport
  /** The first-party provider a request goes to; `null` for every other route. */
  readonly provider: FirstPartyProvider | null
  /** Canonical family key (`gpt-5`, `claude-opus-5`) when an entry matched; else `null`. */
  readonly family: string | null
  /** False for an id no entry matched — capabilities are then the conservative defaults. */
  readonly known: boolean
}

function withFeatures(features: Partial<ModelFeatures> | undefined): ModelFeatures {
  return { ...NO_FEATURES, ...features }
}

function nonFirstPartyTransport(namespace: ModelNamespace): ModelTransport {
  switch (namespace) {
    case 'openrouter':
    case 'extra-provider':
      return 'openai-compatible'
    case 'lmstudio':
      return 'local'
    case 'acp':
    case 'remote-agent':
    case 'plugin-model':
    case 'auto':
      return 'host-routed'
    case 'cloud':
      return 'unknown'
    case 'chatgpt-plan':
      return 'openai-responses'
  }
}

/** API flags need a direct first-party route; lineage flags follow the model. */
function routeGated(features: ModelFeatures, firstParty: boolean): ModelFeatures {
  if (firstParty) return features
  return {
    ...features,
    supportsStrictTools: false,
    supportsVerbosity: false,
    supportsParallelToolCallsControl: false,
    supportsServerCompaction: false,
  }
}

/**
 * Resolve a stored model selection to its route and feature flags.
 *
 * Total: every string resolves, an unrecognised one to the unknown defaults.
 */
export function resolveModelFamily(model: string | ModelSelection): ModelFamilyResolution {
  const selection = typeof model === 'string' ? parseModelSelection(model) : model
  const { namespace } = selection
  if (!CLOUD_ROUTED.has(namespace)) {
    return {
      ...NO_FEATURES,
      namespace,
      transport: nonFirstPartyTransport(namespace),
      provider: null,
      family: null,
      known: false,
    }
  }
  const direct = namespace === 'cloud'
  const entry = findFamily(selection.modelId)
  if (entry !== undefined) {
    return {
      ...routeGated(withFeatures(entry.features), direct),
      namespace,
      transport:
        namespace === 'chatgpt-plan'
          ? 'openai-responses'
          : direct
            ? entry.transport
            : 'openai-compatible',
      provider: direct ? entry.provider : null,
      family: entry.match,
      known: true,
    }
  }
  const fallback = FIRST_PARTY_FALLBACKS.find((candidate) =>
    selection.modelId.startsWith(candidate.prefix),
  )
  if (direct && fallback !== undefined) {
    return {
      ...NO_FEATURES,
      namespace,
      transport: fallback.transport,
      provider: fallback.provider,
      family: null,
      known: false,
    }
  }
  return {
    ...NO_FEATURES,
    namespace,
    transport:
      namespace === 'chatgpt-plan' ? 'openai-responses' : direct ? 'unknown' : 'openai-compatible',
    provider: null,
    family: null,
    known: false,
  }
}

/**
 * The first-party provider `model` is sent to, or `null` when it is not a direct
 * first-party id. The replacement for the `startsWith('claude')` /
 * `startsWith('gpt')` provider checks.
 */
export function firstPartyProviderOf(model: string | ModelSelection): FirstPartyProvider | null {
  return resolveModelFamily(model).provider
}
