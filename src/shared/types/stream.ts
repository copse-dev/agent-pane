export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolCall: ToolCallChunk }
  | { type: 'tool_result'; toolCallId: string; result: string; isError: boolean }
  | {
      type: 'context_trimmed'
      contextWindow: number
      historyBudget: number
      estimatedTokens: number
    }
  | { type: 'done' }

export interface ToolCallChunk {
  id: string
  name: string
  args: unknown
}
