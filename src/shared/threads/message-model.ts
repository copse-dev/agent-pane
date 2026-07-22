import type { Message } from '@shared/types'
import { cloudModelDisplayLabel } from '@copse/llm/model-catalog.ts'
import { isOpenRouterModel, openRouterDisplayLabel } from '@copse/llm/openrouter.ts'
import { isExtraProviderModel, extraProviderDisplayLabel } from '@copse/llm/extra-providers.ts'
import { BEST_VALUE_CHAT_MODEL_LABEL, isBestValueChatModel } from '@shared/lm-studio-defaults.ts'

/**
 * Distinct primary-chat models stamped on assistant messages in this thread.
 * Subagent models are ignored — they already render on their own cards.
 */
export function primaryChatModels(messages: readonly Message[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !msg.model || seen.has(msg.model)) continue
    seen.add(msg.model)
    out.push(msg.model)
  }
  return out
}

/**
 * True when the transcript should show per-message model labels. Any assistant
 * turn with model provenance gets a label — important once the default chat
 * mode auto-picks a plan/price winner, so the user can see which model answered.
 */
export function shouldShowPrimaryChatModelLabels(messages: readonly Message[]): boolean {
  return primaryChatModels(messages).length >= 1
}

/** Display label for a primary-chat model id (matches subagent badge local form). */
export function formatPrimaryChatModelLabel(model: string): string {
  if (isBestValueChatModel(model)) return BEST_VALUE_CHAT_MODEL_LABEL
  if (model.startsWith('lmstudio:')) return `${model.slice('lmstudio:'.length)} · local`
  if (isOpenRouterModel(model)) return openRouterDisplayLabel(model)
  if (isExtraProviderModel(model)) return extraProviderDisplayLabel(model)
  return cloudModelDisplayLabel(model)
}
