import {
  createProvider,
  createLocalOpenAIProvider,
  createOpenRouterProvider,
  createExtraCloudProvider,
} from '@shared/llm/create-provider.ts'
import { isOpenRouterModel, openRouterModelId } from '@shared/llm/openrouter.ts'
import { extraProviderForModel, extraProviderModelId } from '@shared/llm/extra-providers.ts'
import { getResolvedExtraProviders } from './extra-providers-store.ts'
import type { LLMProvider } from '@shared/types'
import {
  DEFAULT_LM_STUDIO_URL,
  LM_STUDIO_MODEL_IDS,
  resolveLocalServerUrl,
} from '@shared/lm-studio-defaults.ts'
import { getSetting, getSettingTrimmed, getLmStudioApiKey, resolveApiKey } from './settings.ts'
import { resolveContextWindow } from './resolve-context-window.ts'
import {
  fetchLmStudioModelsCached,
  invalidateLmStudioModelsCache as invalidateLmStudioModelsCacheImpl,
} from './lm-studio-models.ts'
import { isLocalModel } from '@shared/llm/estimate-cost.ts'
import { withSecretRedaction } from '@shared/llm/redacting-provider.ts'
import { PROVIDER_ENV_VARS } from './env-key-detection.ts'

export { DEFAULT_LM_STUDIO_URL }

/**
 * The user's own configured/known credentials, to redact as literal secrets (on
 * top of the built-in token patterns) before any prompt reaches a remote model
 * (#518). Covers every provider slug we track an env var for, plus OpenRouter and
 * any user-added extra providers, so a model never sees the key minting its own
 * requests echoed back in file contents or tool output.
 */
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

/**
 * Wrap a remote (cloud) provider so messages are scrubbed of secret tokens before
 * they leave the device. Call this only on genuinely remote providers; the local
 * LM Studio path is returned unwrapped so on-device flows keep seeing real tokens.
 */
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
  const configured = getSettingTrimmed(roleKey, roleDefault)
  if (configured) return configured
  const fallback = getSettingTrimmed('localDefaultModel', LM_STUDIO_MODEL_IDS.chat)
  if (fallback) return fallback
  return fetchFirstLocalModel(url)
}

function resolveSubagentLocalModelId(url: string): Promise<string | null> {
  return resolveLocalModelId('subagentModel', url)
}

export interface SubagentRoute {
  provider: LLMProvider
  usageModel: string
  contextWindow: number
  toolSchemaReserve: number
}

/** When the parent chat uses a cloud model, route explore subagents to the local server. */
export async function buildSubagentRoute(parentModel: string): Promise<SubagentRoute | null> {
  if (isLocalChatModel(parentModel)) return null
  if (!getSetting<boolean>('localSubagentsEnabled', true)) return null

  const url = localServerUrl()
  const modelId = await resolveSubagentLocalModelId(url)
  if (!modelId) return null

  const contextWindow = await resolveContextWindow(`lmstudio:${modelId}`)
  return {
    provider: createLocalOpenAIProvider(url, modelId, getLmStudioApiKey()),
    usageModel: `lmstudio:${modelId}`,
    contextWindow,
    toolSchemaReserve: 2_500,
  }
}

/**
 * Route for the post-turn review subagent. Returns a distinct route ONLY when
 * the user has explicitly configured a `reviewModel`; otherwise returns null so
 * the caller reuses the parent chat model (reviewing a diff is judgment work, so
 * the capable chat model is the sensible default rather than a weak local one).
 */
export async function buildReviewRoute(): Promise<SubagentRoute | null> {
  const configured = getSettingTrimmed('reviewModel', '')
  if (!configured) return null

  const url = getSetting<string>('localServerUrl', DEFAULT_LM_STUDIO_URL)
  const modelId = await resolveLocalModelId('reviewModel', url)
  if (!modelId) return null

  const contextWindow = await resolveContextWindow(`lmstudio:${modelId}`)
  return {
    provider: createLocalOpenAIProvider(url, modelId, getLmStudioApiKey()),
    usageModel: `lmstudio:${modelId}`,
    contextWindow,
    toolSchemaReserve: 2_500,
  }
}

// Builds the provider for the main agent loop. LM Studio models are encoded as
// `lmstudio:<modelId>`; the legacy `lm-studio` value resolves to the configured
// model or the first one the server has loaded (never the bogus "local-model").
export async function buildProvider(model: string): Promise<LLMProvider> {
  if (process.env['COPSE_PANEL_MOCK_LLM'] === '1') return createProvider(model)
  if (model === 'lm-studio' || model.startsWith('lmstudio:')) {
    const url = localServerUrl()
    let id = model.startsWith('lmstudio:')
      ? model.slice('lmstudio:'.length)
      : getSetting<string>('localDefaultModel', LM_STUDIO_MODEL_IDS.chat)
    if (!id) id = (await fetchFirstLocalModel(url)) ?? ''
    if (!id) {
      throw new Error(
        'No local model available. Open Settings → Local models, check the server URL/API key, and pick a model.',
      )
    }
    return createLocalOpenAIProvider(url, id, getLmStudioApiKey())
  }
  if (isOpenRouterModel(model)) {
    const apiKey = storedOrEnvApiKey('openrouter')
    if (!apiKey) {
      throw new Error(
        'OpenRouter is not configured. Add an OpenRouter API key in Settings or choose another model.',
      )
    }
    return redactedRemoteProvider(createOpenRouterProvider(openRouterModelId(model), apiKey))
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
    const provider = createExtraCloudProvider(extra, extraProviderModelId(model), apiKey ?? '')
    // Local extras (built-in presets or loopback customs) stay unwrapped so
    // on-device flows keep seeing real tokens in context.
    return extra.local ? provider : redactedRemoteProvider(provider)
  }
  if (model.startsWith('claude')) {
    return redactedRemoteProvider(
      createProvider(model, {
        anthropicApiKey: storedOrEnvApiKey('anthropic'),
      }),
    )
  }
  if (model.startsWith('gpt')) {
    return redactedRemoteProvider(
      createProvider(model, {
        openAiApiKey: storedOrEnvApiKey('openai'),
      }),
    )
  }
  return redactedRemoteProvider(
    createProvider(model, {
      anthropicApiKey: storedOrEnvApiKey('anthropic'),
      openAiApiKey: storedOrEnvApiKey('openai'),
    }),
  )
}

// List the model ids an LM Studio server currently exposes (using saved URL/key).
export async function listLmStudioModels(): Promise<string[]> {
  const url = localServerUrl()
  const r = await fetchLmStudioModelsCached(url)
  return r.ok ? r.models.map((m) => m.id) : []
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
