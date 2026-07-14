import type { ModelComparison } from './thread.ts'
import type { TodoItem } from './todo.ts'
// The provider-emitted chunks are owned by the LLM module; the loop-emitted
// chunks (provider contract + text rewrites, context pressure, subagents) are
// owned by the agent module. The app's StreamChunk is that loop contract plus
// the app-level orchestration events below.
import type { AgentStreamChunk } from '@copse/agent/wire-types.ts'

// `AgentStreamChunk` (what the agent loop emits), `ProviderStreamChunk` (the
// narrow provider contract), and `ToolCallChunk` live in their owning packages;
// re-exported here so app code can name them alongside the fat `StreamChunk`.
export type { AgentStreamChunk } from '@copse/agent/wire-types.ts'
export type { ProviderStreamChunk, ToolCallChunk } from '@copse/llm/wire-types.ts'

/**
 * Everything that can flow through the app's single output stream. It is what
 * the agent loop emits (`AgentStreamChunk`: the provider contract plus text
 * rewrites, context-pressure signals, and subagent lifecycle) plus the
 * app-level orchestration events injected around the loop — todos, history
 * trimming, post-turn review, and the two-model diff comparison. The loop only
 * ever emits the `AgentStreamChunk` subset, so a loop stream is always
 * assignable to a `StreamChunk` sink.
 */
export type StreamChunk =
  | AgentStreamChunk
  | {
      type: 'context_trimmed'
      contextWindow: number
      historyBudget: number
      estimatedTokens: number
    }
  | { type: 'todo_update'; todos: TodoItem[] }
  | {
      type: 'todo_worker_start'
      todoId: string
      content: string
    }
  | { type: 'todo_worker_done'; todoId: string; summary: string; passed: boolean }
  | {
      type: 'post_turn_review'
      status: 'running' | 'done' | 'error' | 'skipped'
      summary: string
      issuesFound?: boolean
    }
  /** Two-model diff-review comparison (running placeholder, then the full result). */
  | { type: 'model_comparison'; comparison: ModelComparison }
