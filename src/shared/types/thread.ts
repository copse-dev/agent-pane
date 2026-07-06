import type { AgentRunPayload } from './skills.ts'
import type { TodoItem } from './todo.ts'
// Token-usage types are owned by the LLM module (a provider reports usage across
// the contract). Imported for use by the thread types below and re-exported so
// `@shared/types` consumers are unchanged.
import type { ModelUsage, ThreadUsage } from '@shared/llm/wire-types.ts'
export type { ModelUsage, ThreadUsage } from '@shared/llm/wire-types.ts'

export type ThreadStatus = 'idle' | 'running' | 'error'

/** User message waiting for the current agent run to finish. */
export interface QueuedUserMessage {
  messageId: string
  payload: AgentRunPayload
  createdAt: number
}

export interface ContextTrimRecord {
  at: number
  contextWindow: number
  historyBudget: number
  estimatedTokens: number
}

/** Live context fill snapshot (updated during an agent run). */
export interface ContextSnapshot {
  contextWindow: number
  conversationBudget: number
  conversationTokens: number
  fillRatio: number
  updatedAt: number
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

/** Verdict from the post-turn review subagent for the most recent editing turn. */
export interface ThreadReview {
  status: 'running' | 'done' | 'error'
  summary: string
}

/**
 * Result of running the working-diff review through two models and a judge that
 * compares their findings (the "model comparison harness"). `reviewA`/`reviewB`
 * are each model's independent verdict; `synthesis` is the judge's comparison
 * (agreements, disagreements, unique catches, overall recommendation).
 */
export interface ModelComparison {
  status: 'running' | 'done' | 'error'
  /** Model ids used for the two reviews (a, b) and the judge synthesis. */
  models: { a: string; b: string; judge: string }
  /** Verdict text from model A. */
  reviewA: string
  /** Verdict text from model B. */
  reviewB: string
  /** The judge's comparison of the two verdicts. */
  synthesis: string
  /** Human-readable cost estimate for the whole run (e.g. `~$0.04`). */
  cost?: string
  /** Populated when `status === 'error'`. */
  error?: string
}

export interface Thread {
  id: string
  title: string
  status: ThreadStatus
  messages: Message[]
  usage: ThreadUsage
  /** Populated when history compaction runs during an agent turn (also in JSONL export). */
  contextTrims?: ContextTrimRecord[]
  /** Latest context fill estimate while the agent is running (or after the last run). */
  contextSnapshot?: ContextSnapshot
  /** Structured task plan for multi-step agent work (updated via update_todos). */
  todos?: TodoItem[]
  /** Latest post-turn review verdict produced after an editing turn. */
  review?: ThreadReview
  /** Latest two-model comparison produced for an editing turn (auto or on demand). */
  comparison?: ModelComparison
  /** Persisted parent/explore goal; set on the first user message in the thread. */
  workingBrief?: string
  /** Git branch this thread was started on; set on first message and persisted. */
  gitBranch?: string
  /** Prompts submitted while the agent is running; drained FIFO when idle. */
  pendingMessages?: QueuedUserMessage[]
  /** True while a queued message is being edited; suspends FIFO draining. */
  queuePaused?: boolean
  /** Unsubmitted composer text; keeps blank threads visible across switches. */
  draftPrompt?: string
  /** Per-thread model override; absent means "use the global default". */
  model?: string
  createdAt: number
  updatedAt: number
}

/**
 * One line of a project's `catalog.jsonl` — a cheap, rebuildable index of its
 * threads used for cross-thread lookup (the `@`-thread picker) without folding
 * every thread. `path` is the thread id (its directory name under the project).
 */
export interface ThreadCatalogEntry {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  digest: string
  path: string
}

/**
 * A catalog entry with its absolute `events.jsonl` path resolved at read time
 * (never persisted — the on-disk catalog stays portable). Returned by the
 * `threads:catalog` IPC and consumed by the `@`-thread picker + steering preamble.
 */
export interface ThreadCatalogHit extends ThreadCatalogEntry {
  spinePath: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'error'
  content: string // accumulated text (appended during streaming)
  /**
   * Accumulated reasoning / "thinking" text streamed before the answer, shown in
   * a collapsible disclosure. Never sent back upstream as conversation history.
   */
  reasoning?: string
  /** Pasted image attachments as data URLs (user messages only). */
  images?: string[]
  toolCalls: ToolCall[]
  /** Small-model rollup label for this message's batch of shell commands. */
  commandSummary?: string
  createdAt: number
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

export interface SubagentMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  toolCalls: ToolCall[]
  /** Wall-clock time the message was first created; absent on sessions persisted before timestamps existed. */
  createdAt?: number
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

export interface UsageDelta extends ModelUsage {
  model: string
}
