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

/** Provider for thread titles, follow-ups, and other lightweight prompts. */
export async function resolveSmallTasksProvider(): Promise<LLMProvider | null> {
  const modelId = resolveSmallTasksModelId()
  try {
    return await buildProvider(modelId, undefined, SMALL_TASK_OPTIONS)
  } catch {
    const chatModel = getSetting<string>('model', DEFAULT_APP_CHAT_MODEL)
    if (chatModel === modelId) return null
    try {
      return await buildProvider(chatModel, undefined, SMALL_TASK_OPTIONS)
    } catch {
      return null
    }
  }
}
