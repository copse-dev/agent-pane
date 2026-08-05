import {
  createProvider,
  createLocalOpenAIProvider,
  createOpenRouterProvider,
  createExtraCloudProvider,
} from '@copse/llm/create-provider.ts'
import { isOpenRouterModel, openRouterModelId } from '@copse/llm/openrouter.ts'
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
  getSetting,
  getSettingTrimmed,
  getLmStudioApiKey,
  resolveApiKey,
} from '../storage/settings.ts'
import { resolveContextWindow } from './resolve-context-window.ts'
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
export async function fetchFirstLocalModel(baseURL: string): Promise<string | null> {
  const result = await fetchLmStudioModelsCached(baseURL)
  return result.models[0]?.id ?? null
}

/**
 * Resolve an LM Studio model id for a given role: the role's configured setting,
 * else the shared `localDefaultModel`, else the first model the server has loaded.
 */
export async function resolveLocalModelId(
  roleKey: string,
  url: string,
  roleDefault = '',
): Promise<string | null> {
  const configured = normalizeRoleModelSelection(routedModelSetting(roleKey, roleDefault))
  if (configured.startsWith('lmstudio:')) return configured.slice('lmstudio:'.length)
  const fallback = normalizeRoleModelSelection(
    getSettingTrimmed('localDefaultModel', LM_STUDIO_MODEL_IDS.chat),
  )
  if (fallback.startsWith('lmstudio:')) return fallback.slice('lmstudio:'.length)
  return fetchFirstLocalModel(url)
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

async function buildTaskRoleRoute(model: string): Promise<SubagentRoute> {
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
function tunedParameters(model: string, opts: BuildProviderOptions = {}): ModelParameters {
  const saved = resolveModelParameters(getSetting<unknown>('modelParameters', {}), model)
  const requested = opts.reasoning ?? saved.reasoning
  const reasoning =
    opts.maxReasoning === undefined ? requested : clampReasoning(requested, opts.maxReasoning)
  return { ...saved, ...(reasoning === undefined ? {} : { reasoning }) }
}

export async function buildProvider(
  model: string,
  promptCacheKey?: string,
  opts: BuildProviderOptions = {},
): Promise<LLMProvider> {
  if (process.env['COPSE_PANEL_MOCK_LLM'] === '1') return createProvider(model)
  const params = tunedParameters(model, opts)
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
    return createLocalOpenAIProvider(url, id, getLmStudioApiKey(), params)
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
        ...openAiServiceTierOption(),
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
      { ...openAiServiceTierOption(), params },
    ),
  )
}

/**
 * The configured OpenAI `service_tier`, or nothing when unset.
 *
 * Trimmed and dropped when blank so a cleared Settings field means "standard
 * processing" (field omitted) rather than sending `service_tier: ""`, which
 * OpenAI rejects. `createProvider` only forwards it to its OpenAI branches.
 */
function openAiServiceTierOption(): { serviceTier?: string } {
  const tier = getSetting<string>('openAiServiceTier', '').trim()
  return tier ? { serviceTier: tier } : {}
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
