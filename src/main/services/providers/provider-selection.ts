import {
  createProvider,
  createLMStudioProvider,
  createOpenRouterProvider,
  createExtraCloudProvider,
} from '@copse/llm/create-provider.ts'
import { isOpenRouterModel, openRouterModelId } from '@copse/llm/openrouter.ts'
import { isDynamicModel } from '@copse/llm/dynamic-model.ts'
import { hostRoutedNamespace, type HostRoutedNamespace } from '@copse/llm/model-selection.ts'
import { SERVICE_TIERS, isServiceTier, type ServiceTier } from '@copse/llm/service-tier.ts'
import { extraProviderForModel, extraProviderModelId } from '@copse/llm/extra-providers.ts'
import { getApprovedProviderHosts } from './approved-provider-hosts.ts'
import { getResolvedExtraProviders } from './extra-providers-store.ts'
import type { LLMProvider } from '@shared/types'
import {
  DEFAULT_LM_STUDIO_URL,
  LM_STUDIO_MODEL_IDS,
  resolveLocalServerUrl,
} from '@shared/lm-studio-defaults.ts'
import {
  getLmStudioApiKey,
  getSetting,
  getSettingTrimmed,
  resolveApiKey,
} from '../storage/settings.ts'
import { resolveContextWindow } from './resolve-context-window.ts'
import { resolveDynamicModelId } from './dynamic-model.ts'
import { routedModelSetting } from './role-models.ts'
import {
  fetchLmStudioModelsCached,
  invalidateLmStudioModelsCache as invalidateLmStudioModelsCacheImpl,
} from './lm-studio-models.ts'
import { isLocalModel } from '@copse/llm/estimate-cost.ts'
import {
  clampReasoning,
  resolveModelParameters,
  type ModelParameters,
  type ReasoningLevel,
} from '@copse/llm/model-parameters.ts'
import { withSecretRedaction } from '@copse/llm/redacting-provider.ts'
import { PROVIDER_ENV_VARS } from './env-key-detection.ts'

export { DEFAULT_LM_STUDIO_URL }

function knownLiteralSecrets(): string[] {
  const slugs = new Set<string>([...Object.keys(PROVIDER_ENV_VARS), 'openrouter'])
  for (const extra of getResolvedExtraProviders()) slugs.add(extra.id)
  const secrets: string[] = []
  for (const slug of slugs) {
    const key = storedOrEnvApiKey(slug)
    if (key) secrets.push(key)
  }
  return secrets
}

function redactedRemoteProvider(provider: LLMProvider): LLMProvider {
  return withSecretRedaction(provider, knownLiteralSecrets())
}

function localServerUrl(): string {
  return resolveLocalServerUrl(getSetting<string>('localServerUrl', ''), process.env)
}

// Stored key with env-var fallback for any provider slug (fixed cloud providers,
// built-in presets, or user customs — the latter resolve to their stored key only).
function storedOrEnvApiKey(provider: string): string | null {
  return resolveApiKey(provider)
}

export function isLocalChatModel(model: string): boolean {
  return isLocalModel(model)
}

/**
 * Role settings historically stored bare LM Studio ids. New role pickers store
 * canonical provider selections, so retain cloud / provider-prefixed values and
 * upgrade every remaining bare value to LM Studio on read.
 */
export function normalizeRoleModelSelection(model: string): string {
  const value = model.trim()
  if (!value) return ''
  if (
    value === 'lm-studio' ||
    // An `auto:` rule is not a bare LM Studio id and must survive intact: the
    // legacy upgrade below would turn `auto:best-local` into
    // `lmstudio:auto:best-local` and route it to a model that cannot exist.
    isDynamicModel(value) ||
    value.startsWith('lmstudio:') ||
    isOpenRouterModel(value) ||
    extraProviderForModel(getResolvedExtraProviders(), value) !== null ||
    value.startsWith('claude-') ||
    value.startsWith('gpt-')
  ) {
    return value
  }
  return `lmstudio:${value}`
}

/**
 * True when running `model` costs money: not an LM Studio / local model and not
 * an OpenAI-compatible *local* extra provider (Ollama, llama.cpp, …). Used to
 * decide whether a model-comparison run needs a spend approval.
 */
export function isBillableModel(model: string): boolean {
  if (isLocalModel(model)) return false
  const extra = extraProviderForModel(getResolvedExtraProviders(), model)
  if (extra?.local) return false
  return true
}

// Fetch the first model id a local OpenAI-compatible server has loaded. Routes
// through the shared cache so repeated callers don't each pay a network round-trip.
async function fetchFirstLocalModel(baseURL: string): Promise<string | null> {
  const result = await fetchLmStudioModelsCached(baseURL)
  return result.models[0]?.id ?? null
}

function defaultOnDeviceModelSelection(): string {
  const configured = normalizeRoleModelSelection(
    getSettingTrimmed('localDefaultModel', LM_STUDIO_MODEL_IDS.chat),
  )
  return configured.startsWith('lmstudio:') ? configured : `lmstudio:${LM_STUDIO_MODEL_IDS.chat}`
}

function routedRoleModelSelection(roleKey: string): string {
  const configured = normalizeRoleModelSelection(routedModelSetting(roleKey))
  return configured || defaultOnDeviceModelSelection()
}

async function buildTaskRoleRoute(selection: string): Promise<SubagentRoute> {
  // A role setting may hold an `auto:` rule (onboarding writes one for every
  // role it configures). Expand it here, before anything downstream treats the
  // value as an id — `usageModel` included, so the ledger records the model
  // that actually ran rather than the rule that chose it.
  const model = await resolveDynamicModelId(selection)
  const contextWindow = await resolveContextWindow(model)
  return {
    provider: await buildProvider(model),
    usageModel: model,
    contextWindow,
    toolSchemaReserve: isLocalChatModel(model) ? 2_500 : 1_000,
  }
}

export interface SubagentRoute {
  provider: LLMProvider
  usageModel: string
  contextWindow: number
  toolSchemaReserve: number
}

/** Route exploration through its selected task-role model. */
export async function buildSubagentRoute(parentModel: string): Promise<SubagentRoute | null> {
  if (!getSetting<boolean>('localSubagentsEnabled', true)) return null
  const model = routedRoleModelSelection('subagentModel')
  if (model === parentModel) return null
  return buildTaskRoleRoute(model)
}

/**
 * Route for the post-turn review subagent. Auto uses the on-device default;
 * users can explicitly choose any connected provider model in Settings.
 */
export async function buildReviewRoute(): Promise<SubagentRoute | null> {
  return buildTaskRoleRoute(routedRoleModelSelection('reviewModel'))
}

// Builds the provider for the main agent loop. LM Studio models are encoded as
// `lmstudio:<modelId>`; the legacy `lm-studio` value resolves to the configured
// model or the first one the server has loaded (never the bogus "local-model").
//
// `promptCacheKey` (typically the thread id) is forwarded to OpenAI-compatible
// cloud providers as `prompt_cache_key` so a conversation's repeated turns route
// to the same prompt cache, lifting hit rates and lowering cost (#584). It is
// intentionally omitted for local servers (LM Studio, Ollama, …), which don't
// honour it and can reject unknown request fields.
export interface BuildProviderOptions {
  /**
   * Reasoning depth for this turn only, from the composer's per-chat dial.
   * Overrides the level saved on the model; the sampling values are untouched,
   * since those are a property of how the user wants the model to write rather
   * than of how hard this particular turn is.
   */
  reasoning?: ReasoningLevel
  /**
   * Ceiling on the reasoning depth, for roles whose job description is cheap
   * and fast — thread titles, follow-up suggestions, shell-command
   * classification. A user who set their chat model to `max` meant it for the
   * work, not for naming the conversation with the same model, and that bill
   * would arrive with nothing on screen to explain it.
   */
  maxReasoning?: ReasoningLevel
}

/**
 * Generation parameters the user tuned for this exact model selection
 * (Settings → Models → Model parameters), sanitized against what the model
 * accepts so a value saved before the selection changed cannot 400 the turn.
 * Empty for every model the user has not touched.
 *
 * Keyed by selection rather than by feature, so a model carries its parameters
 * wherever it runs — chat, a task role, a subagent — the same way an ACP
 * agent's model and permission mode travel with the agent.
 */
export function resolveTurnParameters(
  model: string,
  opts: BuildProviderOptions = {},
): ModelParameters {
  const saved = resolveModelParameters(getSetting<unknown>('modelParameters', {}), model)
  const requested = opts.reasoning ?? saved.reasoning
  const reasoning =
    opts.maxReasoning === undefined ? requested : clampReasoning(requested, opts.maxReasoning)
  return { ...saved, ...(reasoning === undefined ? {} : { reasoning }) }
}

/**
 * Why a route-shaped selection has no provider to build, in the words the
 * surface that asked for one will show.
 *
 * The sentence has to say *which* kind of route it was handed, because the fix
 * differs: three of them are a model the user picked for somewhere it cannot
 * run, and `auto:` is a rule a caller forgot to expand.
 */
const HOST_ROUTED_MESSAGE: Readonly<Record<HostRoutedNamespace, (model: string) => string>> = {
  acp: (model) =>
    `${model} names a device agent, which runs as its own process against your own sign-in — ` +
    'not a model this feature can call. Pick a cloud or local model for it. (Sending the agent ' +
    "id to a cloud provider bills that provider's API for a turn the agent bills to your " +
    'subscription.)',
  'remote-agent': (model) =>
    `${model} names a cloud agent, which runs on its provider's own infrastructure — not a ` +
    'model this feature can call. Pick a cloud or local model for it.',
  'plugin-model': (model) =>
    `${model} names a plugin-provided model route, which only that plugin can run. Pick a cloud ` +
    'or local model for it.',
  auto: (model) =>
    `${model} is an unexpanded model rule. Resolve it with resolveDynamicModelId() before ` +
    'building a provider.',
}

/**
 * Build the LLM provider for a model selection.
 *
 * Every branch below maps a selection onto something callable, and the last one
 * is a fallback that hands whatever it was given to Anthropic (or OpenAI). That
 * fallback is why the guard comes first: `acp:`, `remote-agent:`,
 * `plugin-model:` and `auto:` name a route the *host* takes, not a model, and
 * before this they fell all the way through — so a turn the user had pointed at
 * their own device agent went out to api.anthropic.com, on their stored
 * Anthropic key, carrying `acp:claude-agent-acp#opus[1m]` as the model id
 * (issue #2478).
 *
 * Anthropic rejects an id like that, so the request buys nothing; what it cost
 * was the diagnosis. The rejection is an account-level `400
 * invalid_request_error` — on an account kept at zero API credit because the
 * user works off a subscription, "Your credit balance is too low to access the
 * Anthropic API" — which reads as *Copse is billing the API for this*, and
 * three separate reports concluded exactly that. The quieter defect is the real
 * one: the agent the user picked never ran.
 *
 * Failing here is the fix rather than the symptom: the same fallback sits under
 * every one of this function's callers — thread titles, the safety classifier,
 * comparison reviewers, custom agents — so guarding the one place covers routes
 * that do not exist yet as well as the four that do.
 *
 * Deliberately *after* the mock-mode escape hatch, which is documented to take
 * precedence over routing: demo traces and e2e fixtures carry `acp:` model ids
 * (`demo-traces/landing.ts`), and mock mode never reaches the network, so there
 * is no spend to prevent there and nothing gained by breaking them.
 */
export async function buildProvider(
  model: string,
  promptCacheKey?: string,
  opts: BuildProviderOptions = {},
): Promise<LLMProvider> {
  if (process.env['COPSE_PANEL_MOCK_LLM'] === '1') return createProvider(model)
  const hostRouted = hostRoutedNamespace(model)
  if (hostRouted) throw new Error(HOST_ROUTED_MESSAGE[hostRouted](model))
  const params = resolveTurnParameters(model, opts)
  if (model === 'lm-studio' || model.startsWith('lmstudio:')) {
    const url = localServerUrl()
    const savedLocalDefault = normalizeRoleModelSelection(
      getSetting<string>('localDefaultModel', LM_STUDIO_MODEL_IDS.chat),
    )
    let id = model.startsWith('lmstudio:')
      ? model.slice('lmstudio:'.length)
      : savedLocalDefault.startsWith('lmstudio:')
        ? savedLocalDefault.slice('lmstudio:'.length)
        : LM_STUDIO_MODEL_IDS.chat
    if (!id) id = (await fetchFirstLocalModel(url)) ?? ''
    if (!id) {
      throw new Error(
        'No local model available. Open Settings → Local models, check the server URL/API key, and pick a model.',
      )
    }
    return createLMStudioProvider(url, id, getLmStudioApiKey(), params)
  }
  if (isOpenRouterModel(model)) {
    const apiKey = storedOrEnvApiKey('openrouter')
    if (!apiKey) {
      throw new Error(
        'OpenRouter is not configured. Add an OpenRouter API key in Settings or choose another model.',
      )
    }
    return redactedRemoteProvider(
      createOpenRouterProvider(openRouterModelId(model), apiKey, promptCacheKey, {
        // Privacy routing, toggled in Settings → Providers → OpenRouter:
        // ZDR-only endpoints by default, and providers that train on inputs
        // stay excluded unless explicitly allowed.
        zdrOnly: getSetting<boolean>('openRouterZdrOnly', true),
        allowTraining: getSetting<boolean>('openRouterAllowTraining', false),
        params,
      }),
    )
  }
  const extra = extraProviderForModel(getResolvedExtraProviders(), model)
  if (extra) {
    const apiKey = storedOrEnvApiKey(extra.id)
    // Local servers (Ollama, llama.cpp, …) typically run without auth, so a
    // missing key is fine; createExtraCloudProvider supplies a placeholder.
    if (!apiKey && !extra.local) {
      throw new Error(
        `${extra.label} is not configured. Add a ${extra.label} API key in Settings or choose another model.`,
      )
    }
    const provider = createExtraCloudProvider(
      extra,
      extraProviderModelId(model),
      apiKey ?? '',
      getApprovedProviderHosts(),
      params,
    )
    return extra.local ? provider : redactedRemoteProvider(provider)
  }
  if (model.startsWith('claude')) {
    return redactedRemoteProvider(
      createProvider(model, { anthropicApiKey: storedOrEnvApiKey('anthropic') }, undefined, {
        params,
      }),
    )
  }
  if (model.startsWith('gpt')) {
    return redactedRemoteProvider(
      createProvider(model, { openAiApiKey: storedOrEnvApiKey('openai') }, promptCacheKey, {
        ...openAiRequestOptions(),
        params,
      }),
    )
  }
  return redactedRemoteProvider(
    createProvider(
      model,
      {
        anthropicApiKey: storedOrEnvApiKey('anthropic'),
        openAiApiKey: storedOrEnvApiKey('openai'),
      },
      promptCacheKey,
      { ...openAiRequestOptions(), params },
    ),
  )
}

/**
 * The per-request OpenAI knobs read from settings: processing tier and
 * transport.
 *
/**
 * Per-request OpenAI options resolved from settings.
 *
 * `serviceTier` is trimmed and dropped when blank, so a cleared field means
 * "standard processing" (omitted) rather than `service_tier: ""`, which OpenAI
 * rejects. `forceChatCompletions` pins reasoning-capable models back to
 * /v1/chat/completions; off by default, since the Responses path is what
 * surfaces their reasoning at all. `createProvider` forwards both only to its
 * OpenAI branches.
 *
 * The settings schema already pins tier writes to `SERVICE_TIERS`, but a value
 * stored before that enum existed can still be on disk, so re-check here and
 * drop an unrecognised one with a warning. Sending it would earn a 400 on every
 * turn; dropping it silently would leave someone wondering why their tier had
 * no effect.
 */
function openAiRequestOptions(): { serviceTier?: ServiceTier; forceChatCompletions?: boolean } {
  const forced = getSetting<boolean>('openAiForceChatCompletions', false)
    ? { forceChatCompletions: true as const }
    : {}
  const tier = getSetting<string>('openAiServiceTier', '').trim()
  if (!tier) return forced
  if (!isServiceTier(tier)) {
    console.warn(
      `[providers] ignoring unrecognised openAiServiceTier ${JSON.stringify(tier)}; expected one of ${SERVICE_TIERS.join(', ')}`,
    )
    return forced
  }
  return { serviceTier: tier, ...forced }
}

// List the model ids an LM Studio server currently exposes (using saved URL/key).
export async function listLmStudioModels(): Promise<string[]> {
  const url = localServerUrl()
  const r = await fetchLmStudioModelsCached(url)
  return r.ok ? r.models.map((m) => m.id) : []
}

/** List local models with the capability metadata LM Studio advertises. */
export async function listLmStudioModelInfo(): Promise<
  Array<{ id: string; supportsImages?: boolean }>
> {
  const url = localServerUrl()
  const result = await fetchLmStudioModelsCached(url)
  if (!result.ok) return []
  return result.models.map((model) => ({
    id: model.id,
    ...(model.supportsImages !== undefined ? { supportsImages: model.supportsImages } : {}),
  }))
}

// Drop the cache so the next models query refetches (e.g. right after a manual
// "Test connection" succeeds, or settings change).
export function invalidateLmStudioModelsCache(): void {
  invalidateLmStudioModelsCacheImpl()
}

// Test connectivity to an LM Studio (OpenAI-compatible) server by listing its
// models. Local-only, no billing — safe to call freely.
export async function testLmStudio(
  url: string,
  apiKey?: string,
): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  invalidateLmStudioModelsCacheImpl()
  const r = await fetchLmStudioModelsCached(url, apiKey)
  if (!r.ok) {
    return { ok: false, error: r.error ?? 'Could not list models' }
  }
  return { ok: true, models: r.models.map((m) => m.id) }
}
