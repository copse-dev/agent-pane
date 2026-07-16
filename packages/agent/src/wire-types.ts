// The agent-loop contract and the values that cross it. Everything here must
// travel with the module on extraction: the run input (`AgentRunPayload`), the
// loop's output stream (`AgentStreamChunk` and the subagent session types it
// carries), the tool-execution result contract, and the plan/context shapes the
// loop reads and reports. The app's `@shared/types` re-exports all of these, so
// app code keeps importing them from there (app → package direction).
//
// Provider-level types (`LLMMessage`, `LLMTool`, `ProviderStreamChunk`, …) are
// owned by `@copse/llm`; this module imports them across that package boundary
// and only defines what the *loop* adds on top.
import type {
  ProviderStreamChunk,
  ToolCallChunk,
  ModelUsage,
  UserContent,
} from '@copse/llm/wire-types.ts'
import type { PanelData } from './packs/pack-panel.ts'

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export type TodoCheck =
  | { kind: 'shell'; command: string; expectExit?: number | undefined }
  | { kind: 'fileExists'; path: string }
  | { kind: 'typecheck' }

export type TodoAssignedModel = 'cloud' | 'local'

export interface TodoItem {
  id: string
  content: string
  status: TodoStatus
  check?: TodoCheck
  assignedModel?: TodoAssignedModel
}

/** A todo patch: merges into an existing item by `id`, or adds a new one when
 * `id` is omitted. Used by update_todos and post-turn review todo updates. */
export interface TodoUpdateInput {
  id?: string | undefined
  content: string
  status: TodoStatus
  check?: TodoCheck | undefined
  assignedModel?: TodoAssignedModel | undefined
}

/**
 * The JSON payload a host serializes into an agent run's prompt. Parsed back by
 * `parseAgentRunPayload` — the loop's run input, so the shape lives with the loop.
 */
export interface AgentRunPayload {
  content: UserContent
  invokedSkills?: string[]
  priorTodos?: TodoItem[]
  /** Thread working brief captured in renderer store before the run. */
  workingBrief?: string
  /** Per-thread model override; absent means "use the global default setting". */
  model?: string
  /**
   * Turn-tree epoch this run belongs to (decision 16 / C3). Minted by the
   * renderer for a human submission / release and carried on every dispatch of
   * the turn tree (the initial run and each queue-drained continuation), so the
   * main-process continuation ledger keys the same per-turn-tree counter the
   * renderer's drain-time budget check uses. Absent → the run falls back to the
   * thread id as its turn-tree key.
   */
  turnTreeId?: string
  /**
   * Machine turns already spent in this turn tree before this run (decision 5).
   * The renderer counts queue-drain continuations (hook send-now, stop / subagent
   * follow-ups); the run seeds the shared ledger with it so its in-run
   * tighteners (closeout / pre-review / remediation) share one counter per turn
   * tree rather than restarting the budget each run.
   */
  continuationBudgetUsed?: number
}

/** Per-file line add/delete counts for write_file / str_replace tool cards. */
export interface ToolEditStats {
  additions: number
  deletions: number
}

/** What a tool's `execute` hands back to the loop. */
export type ToolExecuteResult =
  | string
  | {
      result: string
      editStats?: ToolEditStats
      /**
       * Tags the result as agent-authored Markdown so the renderer runs it
       * through the Markdown pipeline instead of a raw `<pre>` (see the
       * matching field on {@link ToolCall}). Most built-in tools return
       * structured plain text and omit this; tools whose result is prose
       * (e.g. `advisor`) set it so headings, lists and code render.
       */
      resultFormat?: 'markdown'
    }

export function normalizeToolExecuteResult(value: ToolExecuteResult): {
  result: string
  editStats?: ToolEditStats
  resultFormat?: 'markdown'
} {
  if (typeof value === 'string') return { result: value }
  return value
}

export interface ToolCall {
  id: string
  name: string
  args: unknown
  status: 'running' | 'done' | 'error'
  result: string | null
  /** Line add/delete counts for file edit tools (write_file, str_replace). */
  editStats?: { additions: number; deletions: number }
  /**
   * ACP tool-call `kind` (e.g. `'execute'`, `'read'`, `'search'`), carried from
   * an external ACP agent so its cards group and label like the built-in tools
   * (see `getToolGroupKey`). Absent for the built-in agent loop.
   */
  kind?: string
  /**
   * How to render `result`. External ACP agents author their tool output as
   * Markdown (fenced code, lists, prose), so it renders through the same
   * Markdown pipeline as assistant messages instead of a raw `<pre>`. Absent
   * (plain text) for built-in tools, whose results are structured payloads.
   */
  resultFormat?: 'markdown'
  subagent?: SubagentSession
}

export interface SubagentMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  toolCalls: ToolCall[]
  /** Wall-clock time the message was first created; absent on sessions persisted before timestamps existed. */
  createdAt?: number
}

export interface SubagentSession {
  id: string
  kind: 'explore' | 'investigate_ci' | 'delegate'
  status: 'running' | 'done' | 'error'
  prompt: string
  summary: string | null
  messages: SubagentMessage[]
  /** Token totals for this subagent's own loop (also folded into the parent thread total). */
  usage?: ModelUsage
  /**
   * Model this subagent ran on (`lmstudio:<id>` = local). Surfaced on the card
   * so "did this explore actually use my local model?" is answerable per run.
   */
  model?: string
  /**
   * True when local subagent routing was enabled but unavailable (LM Studio
   * down / no model resolvable), so the run silently used the cloud parent
   * model. Rendered as a warning on the card — otherwise the fallback is
   * indistinguishable from intentional cloud routing.
   */
  localFallback?: boolean
}

/** Which part of the assembled prompt a breakdown segment represents. */
export type ContextSegmentKey = 'system' | 'tools' | 'mcp' | 'skills' | 'history' | 'message'

/** One slice of the pre-send context estimate (e.g. system prompt, tools, your message). */
export interface ContextBreakdownSegment {
  key: ContextSegmentKey
  label: string
  tokens: number
}

/**
 * Estimated token cost of everything that would be sent on the next prompt,
 * split into named parts. Computed before sending so the composer can show
 * what the default context costs and how the draft message adds to it.
 */
export interface ContextBreakdown {
  segments: ContextBreakdownSegment[]
  totalTokens: number
  contextWindow: number
}

/**
 * Everything the agent loop itself emits on its output stream: the provider
 * contract (`ProviderStreamChunk`) plus the orchestration events the loop
 * injects around provider output — text rewrites, context-pressure signals,
 * and subagent lifecycle. The app widens this with its own app-level events
 * (todo updates, post-turn review, model comparison, …); the loop never emits
 * those, so an app sink is always assignable to a loop sink.
 */
export type AgentStreamChunk =
  | ProviderStreamChunk
  /** Replace accumulated assistant text (e.g. after stripping embedded pseudo tool XML). */
  | { type: 'text_replace'; text: string }
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
  /**
   * Level-2 declarative panel update (P2). A first-party pack emits this to
   * refresh the contents of its named panel slot; the host renders it with a
   * generic list/tree component (no freeform React from a pack yet). Each
   * update **replaces** the panel's contents, matching ACP `plan`'s
   * whole-list-per-update semantics — one adapter away from cross-client
   * rendering. `contributionId` addresses the pack's UI contribution (see
   * {@link PackUiContribution.id}); `packId` scopes it so two packs cannot
   * collide by declaring the same contribution id. Data model + seed transforms
   * live in `packs/pack-panel.ts` (`PanelData`).
   */
  | { type: 'panel_update'; packId: string; contributionId: string; data: PanelData }
