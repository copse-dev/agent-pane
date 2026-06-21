import { getSetting } from './settings.ts'
import { LM_STUDIO_MODEL_IDS } from '@shared/lm-studio-defaults.ts'
import { contextLengthForModel, fetchLmStudioModelsCached } from './lm-studio-models.ts'

const DEFAULT_LM_STUDIO_URL = 'http://localhost:1234/v1'
const DEFAULT_LOCAL_CONTEXT = 8192

// Context window (max input tokens) per cloud model. Claude Sonnet 4.6 and
// Opus 4.8 expose a 1M-token window at standard pricing; Haiku 4.5 is 200K.
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-sonnet-4-6': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-haiku-4-5': 200_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
}

function localModelId(model: string): string | null {
  if (model.startsWith('lmstudio:')) return model.slice('lmstudio:'.length)
  if (model === 'lm-studio')
    return getSetting<string>('lmStudioModel', LM_STUDIO_MODEL_IDS.chat).trim() || null
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
  const mapped = MODEL_CONTEXT_WINDOWS[model]
  if (mapped) return mapped

  if (model === 'lm-studio' || model.startsWith('lmstudio:')) {
    const url = getSetting<string>('lmStudioUrl', DEFAULT_LM_STUDIO_URL)
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

  return 128_000
}
