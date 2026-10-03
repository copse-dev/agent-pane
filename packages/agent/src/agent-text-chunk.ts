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
    // A hyphen at the very end of a word ("sidebar-") is itself the join.
    if (text === trimmedStart && /[A-Za-z]-$/.test(prevText)) return true
    const hasWordBoundary = text !== trimmedStart || /\s$/.test(prevText)
    return hasWordBoundary
  }
  return false
}

// The prior text stops inside a markdown construct that cannot render on its
// own: an unclosed code fence, a table row cut before its closing pipe, or a
// dangling emphasis/code marker. Splitting here strands the markers as literal
// text in one bubble and a headless fragment in the next.
function endsInsideMarkup(text: string): boolean {
  let fence: { character: string; length: number } | undefined
  let lastLineClosesFence = false
  const inlineLines: string[] = []
  for (const line of text.split('\n')) {
    lastLineClosesFence = false
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!match) {
      if (!fence) inlineLines.push(line)
      continue
    }
    const marker = match[1] ?? ''
    const rest = match[2] ?? ''
    if (fence) {
      if (marker[0] === fence.character && marker.length >= fence.length && !rest.trim()) {
        fence = undefined
        lastLineClosesFence = true
      }
    } else if (marker[0] !== '`' || !rest.includes('`')) {
      fence = { character: marker[0] ?? '', length: marker.length }
    } else {
      inlineLines.push(line)
    }
  }
  if (fence) return true
  if (lastLineClosesFence) return false
  if (/\n$/.test(text)) return false
  const lastLine = text.slice(text.lastIndexOf('\n') + 1).trim()
  if (lastLine.startsWith('|') && !lastLine.endsWith('|')) return true
  const trailingMarker = /(\*+|_+|~{2,}|`+)$/.exec(lastLine)?.[1]
  if (!trailingMarker) return false
  // Closing markers are renderable on their own. Only an unmatched terminal
  // run needs the next chunk, preserving the fresh-bubble boundary after a
  // complete span such as "**Completed.**". Escaped runs are literal text.
  let unmatched = false
  let inlineCodeLength: number | undefined
  const inlineText = inlineLines.join('\n')
  for (const match of inlineText.matchAll(/\*+|_+|~{2,}|`+/g)) {
    let precedingBackslashes = 0
    for (let index = match.index - 1; index >= 0 && inlineText[index] === '\\'; index -= 1) {
      precedingBackslashes += 1
    }
    if (precedingBackslashes % 2 !== 0 && inlineCodeLength === undefined) continue
    const marker = match[0]
    if (marker.startsWith('`')) {
      if (inlineCodeLength === undefined) inlineCodeLength = marker.length
      else if (marker.length === inlineCodeLength) inlineCodeLength = undefined
    } else if (inlineCodeLength === undefined && marker === trailingMarker) {
      unmatched = !unmatched
    }
  }
  if (trailingMarker.startsWith('`')) return inlineCodeLength !== undefined
  return unmatched
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
  // Text cut inside a table row, code fence or emphasis marker always resumes.
  const isMidSentenceContinuation =
    !isWhitespaceOnly &&
    state.msgId !== null &&
    state.toolSinceText &&
    (endsInsideMarkup(currentText) ||
      (!endsAtBoundary(currentText) && continuesSentence(currentText, text)))

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
