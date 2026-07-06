import type { ModelComparison, ModelUsage, SubagentSession } from './thread.ts'
import type { TodoItem } from './todo.ts'
// The provider-emitted chunks are owned by the LLM module. The app's StreamChunk
// is that narrow contract plus the agent-loop/orchestration events below.
import type { ProviderStreamChunk, ToolCallChunk } from '@copse/llm/wire-types.ts'

// `ProviderStreamChunk` (the narrow provider contract) and `ToolCallChunk` live
// in the LLM module; re-exported here so app code can name the provider-level
// output type (e.g. provider mocks) alongside the fat `StreamChunk`.
export type { ProviderStreamChunk, ToolCallChunk } from '@copse/llm/wire-types.ts'

/**
 * Everything that can flow through the app's single output stream. It is the
 * provider contract (`ProviderStreamChunk`: text/reasoning/tool_call/
 * tool_result/usage/done) plus the orchestration events the agent loop injects
 * around provider output — subagents, todos, context-window signals, and the
 * two-model diff comparison. Providers only ever emit the `ProviderStreamChunk`
 * subset, so a provider stream is always assignable to a `StreamChunk` sink.
 */
export type StreamChunk =
  | ProviderStreamChunk
  /** Replace accumulated assistant text (e.g. after stripping embedded pseudo tool XML). */
  | { type: 'text_replace'; text: string }
  | {
      type: 'context_trimmed'
      contextWindow: number
      historyBudget: number
      estimatedTokens: number
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
  /** Two-model diff-review comparison (running placeholder, then the full result). */
  | { type: 'model_comparison'; comparison: ModelComparison }
