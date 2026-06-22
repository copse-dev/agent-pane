import type { LLMProvider } from '@shared/types'
import {
  DEFAULT_APP_CHAT_MODEL,
  LM_STUDIO_MODEL_IDS,
  lmStudioChatModelValue,
} from '@shared/lm-studio-defaults.ts'
import { getSetting } from './settings.ts'
import { buildProvider } from './provider-selection.ts'

const AUTO_LOCAL_DEFAULT = lmStudioChatModelValue(LM_STUDIO_MODEL_IDS.smallTasks)

/** Resolve the configured background-tasks model, migrating legacy LM-Studio-only settings. */
export function resolveBackgroundTasksModelId(): string {
  const configured = getSetting<string>('backgroundTasksModel', '').trim()
  if (configured) return configured

  if (!getSetting<boolean>('lmStudioForSmallTasks', true)) {
    return getSetting<string>('model', DEFAULT_APP_CHAT_MODEL)
  }

  const legacyLocal = getSetting<string>('lmStudioSmallTasksModel', '').trim()
  if (legacyLocal) {
    return legacyLocal.includes(':') ? legacyLocal : lmStudioChatModelValue(legacyLocal)
  }

  return AUTO_LOCAL_DEFAULT
}

/** Provider for thread titles, follow-ups, and other lightweight prompts. */
export async function resolveBackgroundTasksProvider(): Promise<LLMProvider | null> {
  const modelId = resolveBackgroundTasksModelId()
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
