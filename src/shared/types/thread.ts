import type { AgentRunPayload } from './skills.ts'
import type { TodoItem } from './todo.ts'
import type { RemoteAgentLink } from '../remote-agent-link.ts'
// Token-usage types are owned by the LLM module (a provider reports usage across
// the contract). Imported for use by the thread types below and re-exported so
// `@shared/types` consumers are unchanged.
import type { ModelUsage, ThreadUsage } from '@copse/llm/wire-types.ts'
export type { ModelUsage, ThreadUsage } from '@copse/llm/wire-types.ts'
// The subagent session/tool-call record and the context-breakdown shapes are
// owned by the agent module (the loop constructs sessions and reports the
// breakdown); imported for the thread types below and re-exported so
// `@shared/types` consumers are unchanged.
import type { ToolCall } from '@copse/agent/wire-types.ts'
export type {
  ToolCall,
  SubagentMessage,
  SubagentSession,
  ContextSegmentKey,
  ContextBreakdownSegment,
  ContextBreakdown,
} from '@copse/agent/wire-types.ts'

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

/** Verdict from the post-turn review subagent for the most recent editing turn. */
export interface ThreadReview {
  status: 'running' | 'done' | 'error' | 'skipped'
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
  /** Latest two-model comparison produced for an editing turn (auto or on demand). */
  comparison?: ModelComparison
  /** Persisted parent/explore goal; set on the first user message in the thread. */
  workingBrief?: string
  /** Git branch this thread was started on; set on first message and persisted. */
  gitBranch?: string
  /**
   * Durable link to the cloud-agent run + PR this thread launched (issue #690).
   * Recorded by the remote-agent clients at launch and completion, not the
   * renderer; the per-project `agent-pr-index.jsonl` is derived from it.
   */
  remoteAgentLink?: RemoteAgentLink
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

/**
 * A display-only attachment chip shown in a user message's transcript. The agent
 * receives the expanded fenced blocks in its run payload, not these — so this is
 * purely how the sent message renders. `paste` chips are positional: each maps,
 * in order, to a U+FFFC (object-replacement) placeholder in the message
 * `content`; `file`/`thread` chips render as a trailing row.
 */
export interface TranscriptAttachment {
  kind: 'paste' | 'file' | 'thread' | 'shell'
  label: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'error'
  content: string // accumulated text (appended during streaming)
  /** Display-only attachment chips for user messages (see {@link TranscriptAttachment}). */
  attachments?: TranscriptAttachment[]
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
  /**
   * Post-turn review verdict for the editing turn this message concluded. Set on
   * the turn's final assistant message so the review joins the transcript inline
   * (in position, one per reviewed turn) rather than as a single trailing card.
   */
  review?: ThreadReview
  createdAt: number
}

export interface UsageDelta extends ModelUsage {
  model: string
}
