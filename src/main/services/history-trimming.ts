import type { LLMMessage, StreamChunk } from '@shared/types'
import {
  trimHistory,
  historyTokenBudget,
  estimateMessageTokens,
  estimateConversationTokens,
  conversationTokenBudget,
} from '@shared/agent/trim-history.ts'

export interface PreparedAgentHistory {
  trimmed: LLMMessage[]
  wasTrimmed: boolean
  historyBudget: number
  conversationBudget: number
  initialConversationTokens: number
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
  return { trimmed, wasTrimmed, historyBudget, conversationBudget, initialConversationTokens }
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
  const notifyTrimmed = (send: () => void) => {
    if (trimNoticeSent) return
    trimNoticeSent = true
    send()
  }
  return { notifyTrimmed }
}
