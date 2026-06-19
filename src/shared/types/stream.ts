export type StreamChunk =
  | { type: 'text'; text: string }
  /** Replace accumulated assistant text (e.g. after stripping embedded pseudo tool XML). */
  | { type: 'text_replace'; text: string }
  | { type: 'tool_call'; toolCall: ToolCallChunk }
  | { type: 'tool_result'; toolCallId: string; result: string; isError: boolean }
  | {
      type: 'context_trimmed'
      contextWindow: number
      historyBudget: number
      estimatedTokens: number
    }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | {
      type: 'context_pressure'
      contextWindow: number
      conversationBudget: number
      conversationTokens: number
      fillRatio: number
    }
  | { type: 'done' }

export interface ToolCallChunk {
  id: string
  name: string
  args: unknown
}
