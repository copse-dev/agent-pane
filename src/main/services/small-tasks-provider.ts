import type { LLMProvider } from '@shared/types'
import {
  DEFAULT_APP_CHAT_MODEL,
  LM_STUDIO_MODEL_IDS,
  lmStudioChatModelValue,
} from '@shared/lm-studio-defaults.ts'
import { getSetting, getSettingTrimmed } from './settings.ts'
import { buildProvider } from './provider-selection.ts'

const AUTO_LOCAL_DEFAULT = lmStudioChatModelValue(LM_STUDIO_MODEL_IDS.smallTasks)

/** Resolve the configured small-tasks model (empty = auto local default). */
export function resolveSmallTasksModelId(): string {
  const configured = getSettingTrimmed('smallTasksModel')
  return configured || AUTO_LOCAL_DEFAULT
}

/** Provider for thread titles, follow-ups, and other lightweight prompts. */
export async function resolveSmallTasksProvider(): Promise<LLMProvider | null> {
  const modelId = resolveSmallTasksModelId()
  try {
    return await buildProvider(modelId)
  } catch {
    const chatModel = getSetting<string>('model', DEFAULT_APP_CHAT_MODEL)
    if (chatModel === modelId) return null
    try {
      return await buildProvider(chatModel)
    } catch {
      return null
    }
  }
}
