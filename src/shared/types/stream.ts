import type { ModelUsage, SubagentSession } from './thread.ts'
import type { TodoItem } from './todo.ts'

export type StreamChunk =
  | { type: 'text'; text: string }
  /** Replace accumulated assistant text (e.g. after stripping embedded pseudo tool XML). */
  | { type: 'text_replace'; text: string }
  /**
   * Incremental reasoning / "thinking" text the model emits before (or alongside)
   * its answer. Surfaced live so the user can click the "Thinking" disclosure and
   * watch what the model is doing. Carried separately from `text` so it never
   * lands in the assistant's answer or the conversation history sent upstream.
   */
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; toolCall: ToolCallChunk }
  | {
      type: 'tool_result'
      toolCallId: string
      result: string
      isError: boolean
      editStats?: { additions: number; deletions: number }
    }
  | {
      type: 'context_trimmed'
      contextWindow: number
      historyBudget: number
      estimatedTokens: number
    }
  | {
      type: 'usage'
      model: string
      inputTokens: number
      outputTokens: number
      cacheReadTokens?: number
      cacheCreationTokens?: number
    }
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
      editStats?: { additions: number; deletions: number }
    }
  | { type: 'subagent_done'; parentToolCallId: string; summary: string; usage?: ModelUsage }
  | { type: 'subagent_error'; parentToolCallId: string; error: string }
  | { type: 'todo_update'; todos: TodoItem[] }
  | {
      type: 'todo_worker_start'
      todoId: string
      content: string
    }
  | { type: 'todo_worker_done'; todoId: string; summary: string; passed: boolean }
  | { type: 'post_turn_review'; status: 'running' | 'done' | 'error'; summary: string }
  | { type: 'done'; stopReason?: string }

export interface ToolCallChunk {
  id: string
  name: string
  args: unknown
  /**
   * Set when the provider could not parse the tool-call arguments JSON (e.g. a
   * truncated or malformed streamed tool call). When present, `args` is not
   * trustworthy and the agent loop must surface an error tool result instead of
   * executing the tool with empty/partial args.
   */
  argsError?: string
}
