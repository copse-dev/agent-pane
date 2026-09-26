import type { LLMProvider } from '@shared/types'
import {
  DEFAULT_APP_CHAT_MODEL,
  LM_STUDIO_MODEL_IDS,
  lmStudioChatModelValue,
} from '@shared/lm-studio-defaults.ts'
import { getSetting } from '../storage/settings.ts'
import { buildProvider, type BuildProviderOptions } from './provider-selection.ts'
import { routedModelSetting } from './role-models.ts'

const AUTO_LOCAL_DEFAULT = lmStudioChatModelValue(LM_STUDIO_MODEL_IDS.smallTasks)

/**
 * These prompts are one-shot and disposable — a thread title, a follow-up
 * suggestion. When the small-tasks route falls back to the chat model, that
 * model may carry a deep reasoning level the user chose for the *work*; spending
 * it here buys nothing and bills like it does. Cap rather than ignore, so a
 * genuinely cheap level the user picked still applies.
 */
const SMALL_TASK_OPTIONS: BuildProviderOptions = { maxReasoning: 'low' }

/** Resolve the configured small-tasks model (empty = auto local default). */
export function resolveSmallTasksModelId(): string {
  const configured = routedModelSetting('smallTasksModel')
  return configured || AUTO_LOCAL_DEFAULT
}

/** A built small-tasks provider and the model it will actually call. */
export interface SmallTasksRoute {
  provider: LLMProvider
  /**
   * The model this provider calls: the small-tasks model, or the chat model
   * when the small-tasks model could not be built. Usage belongs to this id.
   */
  model: string
}

/**
 * Resolve the small-tasks provider together with the model it routes to, so a
 * caller can attribute usage to the model that answered rather than to the
 * configured small-tasks model it fell back from.
 */
export async function resolveSmallTasksRoute(): Promise<SmallTasksRoute | null> {
  // Scenario fixtures own their chat replies. Auxiliary labels use the callers'
  // normal heuristic fallbacks instead of consuming a conversation response.
  if (process.env['COPSE_PANEL_MOCK_LLM'] === '1') return null
  const modelId = resolveSmallTasksModelId()
  try {
    return { provider: await buildProvider(modelId, undefined, SMALL_TASK_OPTIONS), model: modelId }
  } catch {
    const chatModel = getSetting<string>('model', DEFAULT_APP_CHAT_MODEL)
    if (chatModel === modelId) return null
    try {
      return {
        provider: await buildProvider(chatModel, undefined, SMALL_TASK_OPTIONS),
        model: chatModel,
      }
    } catch {
      return null
    }
  }
}

/** Provider for thread titles, follow-ups, and other lightweight prompts. */
export async function resolveSmallTasksProvider(): Promise<LLMProvider | null> {
  return (await resolveSmallTasksRoute())?.provider ?? null
}
