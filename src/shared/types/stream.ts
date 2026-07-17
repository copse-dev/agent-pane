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
      /** Present on terminal done chunks from a structured review verdict. */
      issuesFound?: boolean
    }
  /** Two-model diff-review comparison (running placeholder, then the full result). */
  | { type: 'model_comparison'; comparison: ModelComparison }
  /**
   * Auto-continuation budget fold-back (C3 run→drain direction, decision 5).
   * Emitted once just before the terminal `done`: `used` is the machine turns
   * this run spent in-process (todo closeout / pre-review gate / remediation
   * cycles) for `turnTreeId`, so the renderer folds it onto the turn tree's
   * counter and its next queue drain respects the shared cap. Non-visual — the
   * renderer updates state only (no DOM), and it is dropped when the turn tree's
   * epoch has moved on (a human action reset the budget, decision 16).
   */
  | { type: 'continuation_budget'; used: number; turnTreeId: string }
