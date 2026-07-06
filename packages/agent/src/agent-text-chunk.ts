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

// A chunk that continues (rather than starts) a sentence. Continuation
// punctuation and clitics ('’,;)…–—) attach directly to the previous word, so
// they always count. A bare lowercase word only counts when a whitespace
// word-boundary separates it from the prior text — otherwise joining "thinking"
// and "final answer" would mangle into "thinkingfinal answer". The boundary is
// present when either the prior text ends with whitespace or this chunk begins
// with whitespace.
function continuesSentence(prevText: string, text: string): boolean {
  const trimmedStart = text.trimStart()
  const first = trimmedStart.slice(0, 1)
  if (!first) return false
  if ("'’,;)…–—".includes(first)) return true
  if (first >= 'a' && first <= 'z') {
    const hasWordBoundary = text !== trimmedStart || /\s$/.test(prevText)
    return hasWordBoundary
  }
  return false
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
    continuesSentence(currentText, text)

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
