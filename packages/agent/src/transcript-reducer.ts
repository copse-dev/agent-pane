import type {
  AgentStreamChunk,
  SubagentMessage,
  ToolCall,
  ToolCallUpdateChunk,
} from './wire-types.ts'

/**
 * Applies stream content to a timeline. Callers choose message boundaries and
 * notification delivery; all tool updates resolve their original owner here.
 * No clock, persistence, renderer effects, or host services live in the reducer.
 */
export class TranscriptReducer {
  private readonly tools = new Map<string, { message: SubagentMessage; call: ToolCall }>()

  reduce(
    chunk: AgentStreamChunk | ToolCallUpdateChunk,
    ensureMessage: () => SubagentMessage,
  ): SubagentMessage | null {
    switch (chunk.type) {
      case 'text': {
        const message = ensureMessage()
        message.content += chunk.text
        return message
      }
      case 'reasoning': {
        const message = ensureMessage()
        message.reasoning = (message.reasoning ?? '') + chunk.text
        return message
      }
      case 'tool_call': {
        const message = ensureMessage()
        const call: ToolCall = {
          id: chunk.toolCall.id,
          name: chunk.toolCall.name,
          args: chunk.toolCall.args,
          status: 'running',
          result: null,
        }
        message.toolCalls.push(call)
        this.tools.set(call.id, { message, call })
        return message
      }
      case 'tool_result': {
        const entry = this.tools.get(chunk.toolCallId)
        if (!entry) return null
        entry.call.status = chunk.isError ? 'error' : 'done'
        entry.call.result = chunk.result
        if (chunk.editStats) entry.call.editStats = chunk.editStats
        if (chunk.resultFormat) entry.call.resultFormat = chunk.resultFormat
        return entry.message
      }
      case 'tool_call_update': {
        const entry = this.tools.get(chunk.toolCallId)
        if (!entry) return null
        const call = entry.call
        if (chunk.name !== undefined) call.name = chunk.name
        if (chunk.args !== undefined) call.args = chunk.args
        if (chunk.status !== undefined) call.status = chunk.status
        if (chunk.result !== undefined) call.result = chunk.result
        if (chunk.resultFormat !== undefined) call.resultFormat = chunk.resultFormat
        return entry.message
      }
      default:
        return null
    }
  }

  /** A completed offline transcript cannot retain tools marked as running. */
  finishPending(message: string): void {
    for (const { call } of this.tools.values()) {
      if (call.status === 'running') {
        call.status = 'error'
        call.result = message
      }
    }
  }
}
