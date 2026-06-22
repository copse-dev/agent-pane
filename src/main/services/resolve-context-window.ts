import { getSetting } from './settings.ts'
import { LM_STUDIO_MODEL_IDS, DEFAULT_LM_STUDIO_URL } from '@shared/lm-studio-defaults.ts'
import { getModelInfo } from '@shared/llm/model-catalog.ts'
import { contextLengthForModel, fetchLmStudioModelsCached } from './lm-studio-models.ts'

const DEFAULT_LOCAL_CONTEXT = 8192
// Fallback for unrecognized cloud models. 128K matches the broad floor used by
// gpt-4o-class models — anything narrower would silently over-trim history.
const DEFAULT_CLOUD_CONTEXT = 128_000

function localModelId(model: string): string | null {
  if (model.startsWith('lmstudio:')) return model.slice('lmstudio:'.length)
  if (model === 'lm-studio')
    return getSetting<string>('localDefaultModel', LM_STUDIO_MODEL_IDS.chat).trim() || null
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
