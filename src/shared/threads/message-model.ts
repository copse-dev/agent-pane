import type { Message } from '@shared/types'

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

/** True when the transcript should show per-message model labels. */
export function shouldShowPrimaryChatModelLabels(messages: readonly Message[]): boolean {
  return primaryChatModels(messages).length > 1
}

/** Display label for a primary-chat model id (matches subagent badge local form). */
export function formatPrimaryChatModelLabel(model: string): string {
  if (model.startsWith('lmstudio:')) return `${model.slice('lmstudio:'.length)} · local`
  return model
}
