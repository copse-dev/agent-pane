import type { LLMProvider } from '@shared/types'
import {
  DEFAULT_APP_CHAT_MODEL,
  LM_STUDIO_MODEL_IDS,
  lmStudioChatModelValue,
} from '@shared/lm-studio-defaults.ts'
import { getSetting } from '../storage/settings.ts'
import { resolveDynamicModelId } from './dynamic-model.ts'
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

function mockLlmActive(): boolean {
  return process.env['COPSE_PANEL_MOCK_LLM'] === '1'
}

export interface SmallTasksRoute {
  provider: LLMProvider
  model: string
}

/** Resolve the configured small-tasks model (empty = auto local default). */
export function resolveSmallTasksModelId(): string {
  const configured = routedModelSetting('smallTasksModel')
  return configured || AUTO_LOCAL_DEFAULT
}

async function buildSmallTasksRoute(selection: string): Promise<SmallTasksRoute> {
  const model = await resolveDynamicModelId(selection)
  return {
    provider: await buildProvider(model, undefined, SMALL_TASK_OPTIONS),
    model,
  }
}

/**
 * Resolve the selected chat model as a backup for a failed small-tasks request.
 * The exclusion prevents a configured shared model from being called twice.
 */
export async function resolveSmallTasksFallbackRoute(
  excludeModel?: string,
): Promise<SmallTasksRoute | null> {
  if (mockLlmActive()) return null
  try {
    const selection = getSetting<string>('model', DEFAULT_APP_CHAT_MODEL)
    const model = await resolveDynamicModelId(selection)
    if (model === excludeModel) return null
    return {
      provider: await buildProvider(model, undefined, SMALL_TASK_OPTIONS),
      model,
    }
  } catch {
    return null
  }
}

/**
 * Provider route for thread titles, follow-ups, and other lightweight prompts.
 * Construction failures fall back immediately; callers that need inference-time
 * failover can request {@link resolveSmallTasksFallbackRoute} after a failed call.
 */
export async function resolveSmallTasksRoute(): Promise<SmallTasksRoute | null> {
  // Scenario fixtures own their chat replies. Auxiliary labels use the callers'
  // normal heuristic fallbacks instead of consuming a conversation response.
  if (mockLlmActive()) return null
  try {
    return await buildSmallTasksRoute(resolveSmallTasksModelId())
  } catch {
    return resolveSmallTasksFallbackRoute()
  }
}

/** Provider-only compatibility wrapper for existing small-task services. */
export async function resolveSmallTasksProvider(): Promise<LLMProvider | null> {
  return (await resolveSmallTasksRoute())?.provider ?? null
}
