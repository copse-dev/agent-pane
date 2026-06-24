import type { SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk'
import type { StreamChunk } from '@shared/types'

/**
 * Translate between Copse's internal `StreamChunk` stream and ACP
 * `session/update` payloads. These pure functions are the single mapping point
 * shared by both ACP roles:
 *
 * - **Agent role** (Copse is driven by an ACP client such as Buzz):
 *   {@link streamChunkToSessionUpdate} turns chunks emitted by the agent loop
 *   into updates we notify the client with.
 * - **Client role** (Copse drives an external ACP agent):
 *   {@link sessionUpdateToStreamChunk} turns updates received from the agent
 *   back into chunks the renderer already knows how to display.
 *
 * Chunks/updates without a clean counterpart (usage accounting, context
 * pressure, internal subagent events, plans) map to `null` and are dropped.
 */
export function streamChunkToSessionUpdate(chunk: StreamChunk): SessionUpdate | null {
  switch (chunk.type) {
    case 'text':
    case 'text_replace':
      return {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: chunk.text },
      }
    case 'tool_call':
      return {
        sessionUpdate: 'tool_call',
        toolCallId: chunk.toolCall.id,
        title: chunk.toolCall.name,
        kind: 'other',
        status: 'pending',
        rawInput: chunk.toolCall.args,
      }
    case 'tool_result':
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: chunk.toolCallId,
        status: chunk.isError ? 'failed' : 'completed',
        content: [{ type: 'content', content: { type: 'text', text: chunk.result } }],
      }
    default:
      return null
  }
}

export function sessionUpdateToStreamChunk(update: SessionUpdate): StreamChunk | null {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
      return update.content.type === 'text' ? { type: 'text', text: update.content.text } : null
    case 'tool_call':
      return {
        type: 'tool_call',
        toolCall: { id: update.toolCallId, name: update.title, args: update.rawInput ?? {} },
      }
    case 'tool_call_update': {
      // Only surface terminal states; intermediate progress has no chunk.
      if (update.status !== 'completed' && update.status !== 'failed') return null
      return {
        type: 'tool_result',
        toolCallId: update.toolCallId,
        result: toolCallContentText(update.content),
        isError: update.status === 'failed',
      }
    }
    default:
      return null
  }
}

/** Collect the plain text from a tool call's content blocks. */
function toolCallContentText(content: ToolCallContent[] | null | undefined): string {
  if (!content) return ''
  const parts: string[] = []
  for (const item of content) {
    if (item.type === 'content' && item.content.type === 'text') parts.push(item.content.text)
  }
  return parts.join('')
}
