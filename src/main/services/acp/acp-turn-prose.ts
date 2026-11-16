import type { StreamChunk } from '@shared/types'

/**
 * The agent's own prose in one ACP turn, folded from the chunks it streamed.
 *
 * Agents send prose two ways. A chunk with no message id arrives as `text`; one
 * stamped with the agent's message id (Claude Agent ACP stamps every message
 * with its API message id) arrives as `acp_content` on the `message` channel so
 * the transcript can keep message boundaries. Both are the agent's words and
 * both belong in thread history. Counting only `text` dropped every id-stamped
 * message from history, and from a failed turn's partial transcript.
 *
 * Copse's own notices never pass through here: the turn runner emits them
 * straight to the caller. So this is the agent's words, not ours.
 */
export interface AcpTurnProse {
  /** All of the agent's prose this turn, in the order it streamed. */
  readonly text: string
  /**
   * The prose of the agent's last message: what it wrote after its last tool
   * call, or since its message id last changed. When a turn fails, the agent
   * sometimes writes the cause here and then fails the prompt with a bare
   * JSON-RPC code. Claude Agent ACP streams the CLI's synthetic "Failed to
   * authenticate: OAuth session expired and could not be refreshed" message,
   * then fails with `-32000 Authentication required`.
   */
  readonly finalMessage: string
  /** The message id the final message arrived under, when it had one. */
  readonly messageId: string | null
}

export const EMPTY_ACP_TURN_PROSE: AcpTurnProse = { text: '', finalMessage: '', messageId: null }

/** The agent prose a chunk carries, or `null` for any other chunk. */
function proseOf(chunk: StreamChunk): string | null {
  if (chunk.type === 'text') return chunk.text
  if (chunk.type === 'acp_content' && chunk.channel === 'message' && chunk.content.type === 'text')
    return chunk.content.text
  return null
}

/** Fold one agent-authored chunk into the turn's prose. */
export function nextAcpTurnProse(previous: AcpTurnProse, chunk: StreamChunk): AcpTurnProse {
  // A tool call ends the message before it: the next prose is a new message.
  if (chunk.type === 'tool_call') return { ...previous, finalMessage: '' }
  const prose = proseOf(chunk)
  if (prose === null) return previous
  const messageId = chunk.type === 'acp_content' ? (chunk.messageId ?? null) : null
  const newMessage = messageId !== null && messageId !== previous.messageId
  return {
    text: previous.text + prose,
    finalMessage: newMessage ? prose : previous.finalMessage + prose,
    messageId: messageId ?? previous.messageId,
  }
}
