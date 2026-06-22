import { createProvider, createLMStudioProvider } from '@shared/llm/create-provider.ts'
import type { LLMProvider } from '@shared/types'
import { DEFAULT_LM_STUDIO_URL, LM_STUDIO_MODEL_IDS } from '@shared/lm-studio-defaults.ts'
import { getSetting, getApiKey, getLmStudioApiKey } from './settings.ts'
import { resolveContextWindow } from './resolve-context-window.ts'
import {
  fetchLmStudioModelsCached,
  invalidateLmStudioModelsCache as invalidateLmStudioModelsCacheImpl,
} from './lm-studio-models.ts'
import { isLocalModel } from '@shared/llm/estimate-cost.ts'

export { DEFAULT_LM_STUDIO_URL }

function storedOrEnvApiKey(provider: 'anthropic' | 'openai'): string | null {
  if (provider === 'anthropic')
    return getApiKey('anthropic') ?? process.env.ANTHROPIC_API_KEY ?? null
  return getApiKey('openai') ?? process.env.OPENAI_API_KEY ?? null
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

async function resolveSubagentLocalModelId(url: string): Promise<string | null> {
  const configured = getSetting<string>('subagentModel', '').trim()
  if (configured) return configured
  const fallback = getSetting<string>('localDefaultModel', LM_STUDIO_MODEL_IDS.chat).trim()
  if (fallback) return fallback
  return fetchFirstLocalModel(url)
}

export interface SubagentRoute {
  provider: LLMProvider
  usageModel: string
  contextWindow: number
  toolSchemaReserve: number
}

/** When the parent chat uses a cloud model, route explore subagents to LM Studio. */
export async function buildSubagentRoute(parentModel: string): Promise<SubagentRoute | null> {
  if (isLocalChatModel(parentModel)) return null
  if (!getSetting<boolean>('localSubagentsEnabled', true)) return null

  const url = getSetting<string>('localServerUrl', DEFAULT_LM_STUDIO_URL)
  const modelId = await resolveSubagentLocalModelId(url)
  if (!modelId) return null

  const contextWindow = await resolveContextWindow(`lmstudio:${modelId}`)
  return {
    provider: createLMStudioProvider(url, modelId, getLmStudioApiKey()),
    usageModel: `lmstudio:${modelId}`,
    contextWindow,
    toolSchemaReserve: 2_500,
  }
}

// Builds the provider for the main agent loop. LM Studio models are encoded as
// `lmstudio:<modelId>`; the legacy `lm-studio` value resolves to the configured
// model or the first one the server has loaded (never the bogus "local-model").
export async function buildProvider(model: string): Promise<LLMProvider> {
  if (model === 'lm-studio' || model.startsWith('lmstudio:')) {
    const url = getSetting<string>('localServerUrl', DEFAULT_LM_STUDIO_URL)
    let id = model.startsWith('lmstudio:')
      ? model.slice('lmstudio:'.length)
      : getSetting<string>('localDefaultModel', LM_STUDIO_MODEL_IDS.chat)
    if (!id) id = (await fetchFirstLocalModel(url)) ?? ''
    if (!id) {
      throw new Error(
        'No LM Studio model available. Open Settings → LM Studio, check the server URL/API key, and pick a model.',
      )
    }
    return createLMStudioProvider(url, id, getLmStudioApiKey())
  }
  if (process.env.COPSE_PANEL_MOCK_LLM === '1') return createProvider(model)
  if (model.startsWith('claude')) {
    return createProvider(model, {
      anthropicApiKey: storedOrEnvApiKey('anthropic'),
    })
  }
  if (model.startsWith('gpt')) {
    return createProvider(model, {
      openAiApiKey: storedOrEnvApiKey('openai'),
    })
  }
  return createProvider(model, {
    anthropicApiKey: storedOrEnvApiKey('anthropic'),
    openAiApiKey: storedOrEnvApiKey('openai'),
  })
}

// List the model ids an LM Studio server currently exposes (using saved URL/key).
export async function listLmStudioModels(): Promise<string[]> {
  const url = getSetting<string>('localServerUrl', DEFAULT_LM_STUDIO_URL)
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
