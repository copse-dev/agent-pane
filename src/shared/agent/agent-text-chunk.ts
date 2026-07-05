export interface AgentTextChunkState {
  msgId: string | null
  toolSinceText: boolean
  // Accumulated visible text of the current assistant message. Used by the
  // continuation heuristic to decide whether a post-tool chunk resumes an
  // interrupted sentence (append) or begins a fresh answer (new bubble).
  currentText?: string
}

export type AgentTextChunkPlan =
  | { action: 'ignore' }
  | {
      action: 'append'
      text: string
      finalizeMsgId?: string
      startNewMessage: boolean
    }

// A sentence/paragraph boundary: terminal punctuation as the last visible char,
// or a trailing newline (a paragraph/list break).
function endsAtBoundary(text: string): boolean {
  const trailingWhitespace = text.slice(text.trimEnd().length)
  if (trailingWhitespace.includes('\n')) return true
  const lastVisible = text.trimEnd().slice(-1)
  return lastVisible === '.' || lastVisible === '?' || lastVisible === '!' || lastVisible === ':'
}

// A chunk that continues (rather than starts) a sentence: it begins with a
// lowercase letter, an apostrophe, a comma, or a similar continuation char.
function continuesSentence(text: string): boolean {
  const first = text.trimStart().slice(0, 1)
  if (!first) return false
  if (first >= 'a' && first <= 'z') return true
  return "'’,;)…–—".includes(first)
}

export function planAgentTextChunk(
  state: AgentTextChunkState,
  text: string,
): { plan: AgentTextChunkPlan; state: AgentTextChunkState } {
  const isWhitespaceOnly = text.length > 0 && !text.trim()
  const currentText = state.currentText ?? ''

  // Whitespace between tool calls must not start a new assistant bubble.
  if (isWhitespaceOnly && state.toolSinceText) {
    return { plan: { action: 'ignore' }, state }
  }

  // Nothing to append to yet.
  if (isWhitespaceOnly && !state.msgId) {
    return { plan: { action: 'ignore' }, state }
  }

  // Continuation heuristic: a tool call interrupted the model mid-sentence. If
  // the pre-tool text has no boundary and this chunk resumes the sentence, keep
  // it in the same bubble instead of stranding the fragment in its own message.
  const isMidSentenceContinuation =
    !isWhitespaceOnly &&
    state.msgId !== null &&
    state.toolSinceText &&
    !endsAtBoundary(currentText) &&
    continuesSentence(text)

  const needsNewMessage = (!state.msgId || state.toolSinceText) && !isMidSentenceContinuation
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
      state: { msgId: null, toolSinceText: false, currentText: text },
    }
  }

  return {
    plan: { action: 'append', text, startNewMessage: false },
    state: { ...state, toolSinceText: false, currentText: currentText + text },
  }
}
