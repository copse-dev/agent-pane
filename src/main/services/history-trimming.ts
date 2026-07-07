import type { LLMMessage, StreamChunk } from '@shared/types'
import {
  trimHistory,
  historyTokenBudget,
  estimateMessageTokens,
  estimateConversationTokens,
  conversationTokenBudget,
} from '@copse/agent/trim-history.ts'

export interface PreparedAgentHistory {
  trimmed: LLMMessage[]
  wasTrimmed: boolean
  historyBudget: number
  conversationBudget: number
  initialConversationTokens: number
  /** Estimated tokens of the whole prompt (system + trimmed conversation). */
  estimatedPromptTokens: number
}

export function prepareAgentHistory(
  messages: LLMMessage[],
  contextWindow: number,
  toolSchemaReserve: number,
): PreparedAgentHistory {
  const historyBudget = historyTokenBudget(contextWindow, { reserveTokens: toolSchemaReserve })
  const { messages: trimmed, trimmed: wasTrimmed } = trimHistory(messages, contextWindow, {
    reserveTokens: toolSchemaReserve,
  })
  const conversationBudget = conversationTokenBudget(trimmed, contextWindow, {
    reserveTokens: toolSchemaReserve,
  })
  const initialConversationTokens = estimateConversationTokens(trimmed)
  const estimatedPromptTokens = estimateMessageTokens(trimmed)
  return {
    trimmed,
    wasTrimmed,
    historyBudget,
    conversationBudget,
    initialConversationTokens,
    estimatedPromptTokens,
  }
}

/**
 * True when the prompt cannot fit the model context even after trimming.
 *
 * Trimming only drops whole non-system messages and never removes the user's
 * own messages (LM Studio chat templates require a user query), so a single
 * oversized turn — e.g. a large pasted block or file attachment inlined into
 * one user message — is irreducible. Sending it anyway guarantees a provider
 * "context length" rejection and, on metered providers, wastes input-token
 * rate-limit budget on a request that can never succeed. The `>=` margin keeps
 * the rough (~4 chars/token) estimate from blocking a turn that would actually
 * fit: it only triggers when the estimate alone meets or exceeds the entire
 * window, leaving no room for any completion.
 */
export function promptExceedsContextWindow(
  prepared: PreparedAgentHistory,
  contextWindow: number,
): boolean {
  return prepared.estimatedPromptTokens >= contextWindow
}

/** User-facing guidance when a single turn is too large for the model. */
export function oversizedTurnMessage(contextWindow: number, estimatedPromptTokens: number): string {
  return (
    `This message is too large for the selected model — it needs roughly ` +
    `${Math.round(estimatedPromptTokens).toLocaleString()} tokens but the model's context ` +
    `window is only ${contextWindow.toLocaleString()}. Remove or shorten large attachments or ` +
    `pasted text, ask the agent to read large files in chunks with read_file, or switch to a ` +
    `model with a larger context window.`
  )
}

export function contextTrimmedChunk(
  trimmed: LLMMessage[],
  contextWindow: number,
  historyBudget: number,
): StreamChunk {
  return {
    type: 'context_trimmed',
    contextWindow,
    historyBudget,
    estimatedTokens: Math.round(estimateMessageTokens(trimmed)),
  }
}

export function contextPressureChunk(
  prepared: PreparedAgentHistory,
  contextWindow: number,
): StreamChunk {
  return {
    type: 'context_pressure',
    contextWindow,
    conversationBudget: prepared.conversationBudget,
    conversationTokens: prepared.initialConversationTokens,
    fillRatio: prepared.initialConversationTokens / prepared.conversationBudget,
  }
}

/** Dedupes context_trimmed notifications (initial trim + loop callbacks). */
export function createTrimNotifier(wasTrimmedInitially: boolean): {
  notifyTrimmed: (send: () => void) => void
} {
  let trimNoticeSent = wasTrimmedInitially
  const notifyTrimmed = (send: () => void): void => {
    if (trimNoticeSent) return
    trimNoticeSent = true
    send()
  }
  return { notifyTrimmed }
}
