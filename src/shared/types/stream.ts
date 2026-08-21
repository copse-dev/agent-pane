import type { ModelComparison } from './thread.ts'
import type { HookCard } from '../hooks/hook-card.ts'
import type { TodoItem } from './todo.ts'
import type { ModelParameters } from '@copse/llm/model-parameters.ts'
// The provider-emitted chunks are owned by the LLM module; the loop-emitted
// chunks (provider contract + text rewrites, context pressure, subagents) are
// owned by the agent module. The app's StreamChunk is that loop contract plus
// the app-level orchestration events below.
import type { AgentStreamChunk } from '@copse/agent/wire-types.ts'
import type { TurnOutcome } from './turn-outcome.ts'

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
  /**
   * Patch an existing external ACP tool call. ACP agents may send the title and
   * raw input on the initial `tool_call`, then replace input/output/status in
   * later `tool_call_update` notifications. Keeping that patch shape intact
   * prevents clients from losing arguments or streamed output before the final
   * completion update arrives.
   */
  | {
      type: 'tool_call_update'
      toolCallId: string
      name?: string
      args?: unknown
      status?: 'running' | 'done' | 'error'
      result?: string
      resultFormat?: 'markdown'
    }
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
   * this run spent in-process (ACP unfinished-turn recovery / todo closeout /
   * pre-review gate / remediation cycles) for `turnTreeId`, so the renderer
   * folds it onto the turn tree's counter and its next queue drain respects the
   * shared cap. Non-visual — the renderer updates state only (no DOM), and it is
   * dropped when the turn tree's epoch has moved on (a human action reset the
   * budget, decision 16).
   */
  | { type: 'continuation_budget'; used: number; turnTreeId: string }
  /** Durable terminal metadata; emitted immediately before the terminal `done`. */
  | { type: 'turn_outcome'; outcome: TurnOutcome }
  /**
   * A hook execution / decision / halt fired during the run (decision 10). The
   * card is derived from the same always-on spine `hook_run` record (decision 6)
   * that history renders from, so the live transcript and a reloaded thread show
   * an identical hook-card family. The renderer anchors it to the current turn's
   * message, mirroring how tool calls attach to the live assistant message.
   */
  | { type: 'hook_run'; card: HookCard }
  /**
   * The generation parameters this turn resolved to, emitted once before the
   * first token. The renderer stamps them on the assistant message so the
   * transcript records what the turn *sent* rather than what Settings says
   * later: the saved values are mutable, and resolution can differ from them
   * (a stale value is dropped, a per-chat dial overrides the level, a cheap
   * role caps it). Emitted only when the turn actually sent parameters.
   */
  | { type: 'turn_parameters'; model: string; parameters: ModelParameters; requestedModel?: string }
