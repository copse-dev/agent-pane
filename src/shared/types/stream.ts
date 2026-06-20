import type { SubagentSession } from './thread.ts'

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
  | { type: 'usage'; model: string; inputTokens: number; outputTokens: number }
  | {
      type: 'context_pressure'
      contextWindow: number
      conversationBudget: number
      conversationTokens: number
      fillRatio: number
    }
  | { type: 'subagent_start'; parentToolCallId: string; session: SubagentSession }
  | { type: 'subagent_text'; parentToolCallId: string; messageId: string; text: string }
  | {
      type: 'subagent_tool_call'
      parentToolCallId: string
      messageId: string
      toolCall: ToolCallChunk
    }
  | {
      type: 'subagent_tool_result'
      parentToolCallId: string
      toolCallId: string
      result: string
      isError: boolean
    }
  | { type: 'subagent_done'; parentToolCallId: string; summary: string }
  | { type: 'subagent_error'; parentToolCallId: string; error: string }
  | { type: 'done' }

export interface ToolCallChunk {
  id: string
  name: string
  args: unknown
}
