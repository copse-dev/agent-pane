export interface AgentTextChunkState {
  msgId: string | null
  toolSinceText: boolean
}

export type AgentTextChunkPlan =
  | { action: 'ignore' }
  | {
      action: 'append'
      text: string
      finalizeMsgId?: string
      startNewMessage: boolean
    }

export function planAgentTextChunk(
  state: AgentTextChunkState,
  text: string,
): { plan: AgentTextChunkPlan; state: AgentTextChunkState } {
  const isWhitespaceOnly = text.length > 0 && !text.trim()

  // Whitespace between tool calls must not start a new assistant bubble.
  if (isWhitespaceOnly && state.toolSinceText) {
    return { plan: { action: 'ignore' }, state }
  }

  // Nothing to append to yet.
  if (isWhitespaceOnly && !state.msgId) {
    return { plan: { action: 'ignore' }, state }
  }

  const needsNewMessage = !state.msgId || state.toolSinceText
  if (!isWhitespaceOnly && needsNewMessage) {
    const plan: AgentTextChunkPlan = state.msgId
      ? {
          action: 'append',
          text,
          finalizeMsgId: state.msgId,
          startNewMessage: true,
        }
      : {
          action: 'append',
          text,
          startNewMessage: true,
        }
    return {
      plan,
      state: { msgId: null, toolSinceText: false },
    }
  }

  return {
    plan: { action: 'append', text, startNewMessage: false },
    state: { ...state, toolSinceText: false },
  }
}
