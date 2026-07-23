import { getSetting, getSettingTrimmed } from '../storage/settings.ts'
import { LM_STUDIO_MODEL_IDS, DEFAULT_LM_STUDIO_URL } from '@shared/lm-studio-defaults.ts'
import { getModelInfo } from '@copse/llm/model-catalog.ts'
import { isOpenRouterModel, openRouterModelId } from '@copse/llm/openrouter.ts'
import { extraProviderContextWindow, isExtraProviderModel } from '@copse/llm/extra-providers.ts'
import { getResolvedExtraProviders } from './extra-providers-store.ts'
import { contextLengthForModel, fetchLmStudioModelsCached } from './lm-studio-models.ts'
import { openRouterModelContextLength } from './openrouter-models.ts'

const DEFAULT_LOCAL_CONTEXT = 8192
// Fallback for unrecognized cloud models. 128K matches the broad floor used by
// gpt-4o-class models — anything narrower would silently over-trim history.
const DEFAULT_CLOUD_CONTEXT = 128_000

function localModelId(model: string): string | null {
  if (model.startsWith('lmstudio:')) return model.slice('lmstudio:'.length)
  if (model === 'lm-studio') {
    const configured = getSettingTrimmed('localDefaultModel', LM_STUDIO_MODEL_IDS.chat)
    if (configured.startsWith('lmstudio:')) return configured.slice('lmstudio:'.length)
    // Provider-prefixed / cloud role choices must not be sent to LM Studio.
    if (
      configured.includes(':') ||
      configured.startsWith('claude-') ||
      configured.startsWith('gpt-')
    ) {
      return LM_STUDIO_MODEL_IDS.chat
    }
    return configured || null
  }
  return null
}

/** Best-effort read of context length for one model id (uses shared models fetch). */
export async function fetchLmStudioModelContextLength(
  baseURL: string,
  modelId: string,
): Promise<number | null> {
  const r = await fetchLmStudioModelsCached(baseURL)
  if (!r.ok) return null
  return contextLengthForModel(r.models, modelId)
}

/**
 * Context window used for history trimming. Local models use LM Studio’s reported
 * per-model context (loaded length when exposed by the server), not a manual setting.
 */
export async function resolveContextWindow(model: string): Promise<number> {
  const cloud = getModelInfo(model)
  if (cloud) return cloud.contextWindow

  // Mock LLM ignores provider context limits. Without a live LM Studio server the
  // local path falls back to 8192, which is narrower than system + tool schemas +
  // a mid-size skill body (e.g. /checkup) and trips the oversized-turn gate in
  // e2e/dev even though the mock would answer fine.
  if (process.env['COPSE_PANEL_MOCK_LLM'] === '1') {
    return DEFAULT_CLOUD_CONTEXT
  }

  if (isOpenRouterModel(model)) {
    const ctx = await openRouterModelContextLength(openRouterModelId(model))
    return ctx ?? DEFAULT_CLOUD_CONTEXT
  }

  if (isExtraProviderModel(model)) {
    return extraProviderContextWindow(getResolvedExtraProviders(), model) ?? DEFAULT_CLOUD_CONTEXT
  }

  if (model === 'lm-studio' || model.startsWith('lmstudio:')) {
    const url = getSetting<string>('localServerUrl', DEFAULT_LM_STUDIO_URL)
    const id = localModelId(model)
    if (id) {
      const r = await fetchLmStudioModelsCached(url)
      if (r.ok) {
        const fromServer = contextLengthForModel(r.models, id)
        if (fromServer) return fromServer
      }
    }
    return DEFAULT_LOCAL_CONTEXT
  }

  return DEFAULT_CLOUD_CONTEXT
}
