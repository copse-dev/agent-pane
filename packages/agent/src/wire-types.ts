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
}

/** Per-file line add/delete counts for write_file / str_replace tool cards. */
export interface ToolEditStats {
  additions: number
  deletions: number
}

/** What a tool's `execute` hands back to the loop. */
export type ToolExecuteResult = string | { result: string; editStats?: ToolEditStats }

export function normalizeToolExecuteResult(value: ToolExecuteResult): {
  result: string
  editStats?: ToolEditStats
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
  kind: 'explore' | 'investigate_ci'
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
