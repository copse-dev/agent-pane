import type { AgentRunPayload } from './skills.ts'
import type { TodoItem } from './todo.ts'
import type { RemoteAgentLink } from '../remote-agent-link.ts'
import type { HookCard } from '../hooks/hook-card.ts'
import type { ThreadWorktree, ThreadWorktreeChoice } from './worktree.ts'
export type { HookCard } from '../hooks/hook-card.ts'
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

/**
 * Provenance of a queued message (decision 10). A queued message can be authored
 * by a human (origin absent) or produced by an async hook's `queueMessage`
 * output — the only async output channel (decision 4). The message role stays
 * `user` for the LLM; `origin` lives purely in the data model so the UI can
 * attribute it and the spine stays honest about authorship.
 */
export interface QueuedMessageOrigin {
  kind: 'hook'
  /** Registered hook id that produced the message. */
  hookId: string
  /** Canonical event the hook fired on (e.g. `stop`, `afterToolUse`). */
  event: string
}

/** User message waiting for the current agent run to finish. */
export interface QueuedUserMessage {
  messageId: string
  payload: AgentRunPayload
  createdAt: number
  /**
   * Where the message came from (decision 10). Absent = human-authored. A
   * hook-originated message keeps `kind: 'hook'` even after a human edits it
   * (that flips {@link editedByUser} instead), so authorship is never lost.
   */
  origin?: QueuedMessageOrigin
  /**
   * True once a human edits a hook-originated message (decision 10). The origin
   * stays `kind: 'hook'`; this records that the text no longer matches the hook's
   * output so the spine stays honest.
   */
  editedByUser?: boolean
  /**
   * **Held** (decisions 5 & 16). When `false`, `drainMessageQueue` skips this
   * item entirely — it never auto-submits at idle; only an explicit human action
   * (release / send-now) dispatches it, starting a fresh turn tree. Absent means
   * a normal auto-draining queued message. Only ever `false` (never `true`) so a
   * "held" item is unrepresentable as auto-dispatching (execution-guidance rule
   * 3). Set when a stale-epoch hook send-now downgrades (decision 16), and — in
   * C3 — when an over-budget hook message arrives.
   */
  autoDispatch?: false
  /**
   * Emitting turn-tree epoch (decision 16) for hook-originated items. Compared
   * against the thread's current turn tree to detect a stale late output; a
   * stale send-now downgrades to held rather than aborting an unrelated turn.
   */
  epoch?: string
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
  /**
   * Structured signal from the review subagent (`REVIEW_JSON.issuesFound`).
   * Absent on older persisted reviews; when explicitly `false` the renderer
   * collapses the review card by default.
   */
  issuesFound?: boolean
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
  /** Validated linked checkout owned by this thread; absence means shared mode. */
  worktree?: ThreadWorktree
  /** Checkout decision captured once when the thread sends its first message. */
  worktreeChoice?: ThreadWorktreeChoice
  /**
   * Durable link to the cloud-agent run + PR this thread launched (issue #690).
   * Recorded by the remote-agent clients at launch and completion, not the
   * renderer; the per-project `agent-pr-index.jsonl` is derived from it.
   */
  remoteAgentLink?: RemoteAgentLink
  /** Prompts submitted while the agent is running; drained FIFO when idle. */
  pendingMessages?: QueuedUserMessage[]
  /**
   * Epoch (turn-tree id) of the current, human-initiated turn tree (decision
   * 16). Set when a human submission / release / send-now starts a fresh turn
   * tree; an async hook's `queueMessage` output carries the epoch of the turn it
   * was emitted from, and an epoch that no longer matches this is **stale** — its
   * send-now downgrades to a held queued message instead of aborting an unrelated
   * turn. The authoritative turn-tree ledger is C3; C2 tracks the current epoch
   * so the staleness check (decision 16) has a reference point.
   */
  currentEpoch?: string
  /**
   * Machine-initiated new turns already spent in the current turn tree (decision
   * 5, C3). Counts queue-drain continuations (hook send-now, stop / subagent
   * follow-ups) as they auto-dispatch; when it reaches the cap
   * (`DEFAULT_CONTINUATION_BUDGET`), `drainMessageQueue` flips a further
   * machine-originated message to **held** instead of auto-submitting. Reset to 0
   * when a human action (typed prompt / release) starts a fresh turn tree. The
   * run seeds the main-process ledger with this so its in-run tighteners
   * (closeout / pre-review / remediation) share one counter per turn tree.
   */
  continuationUsed?: number
  /** True while a queued message is being edited; suspends FIFO draining. */
  queuePaused?: boolean
  /** Unsubmitted composer text; keeps blank threads visible across switches. */
  draftPrompt?: string
  /** Per-thread model override; absent means "use the global default". */
  model?: string
  /**
   * When set, the thread is archived: hidden from the sidebar and `@`-thread
   * catalog, but kept on disk under `~/.copse/workspace/<projectId>/<id>/`.
   * Soft-hide (not a delete) — restore is a later UI concern.
   */
  archivedAt?: number
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
   * Small-model polish for the turn's tool rollup (`.tool-card-rollup`). The
   * deterministic canned label shows immediately; this replaces it when ready
   * and never blocks delivery.
   */
  toolSummary?: string
  /**
   * Primary-chat model that produced this assistant message (picker id for the
   * turn). Surfaced in the transcript only when the thread used more than one
   * primary model — subagent models live on {@link SubagentSession.model}.
   */
  model?: string
  /**
   * Post-turn review verdict for the editing turn this message concluded. Set on
   * the turn's final assistant message so the review joins the transcript inline
   * (in position, one per reviewed turn) rather than as a single trailing card.
   */
  review?: ThreadReview
  /**
   * Provenance when this turn was started by a hook follow-up (decision 10). The
   * message role stays `user` for the LLM; `origin` lives purely in the data
   * model so the transcript can mark a hook-originated turn (a hook send-now /
   * `stop`-follow-up that dispatched). Carried through the spine so the marker
   * survives a reload (history stays honest about authorship). `editedByUser`
   * flips `true` once a human edits a hook-queued message before it dispatches.
   */
  origin?: QueuedMessageOrigin
  editedByUser?: boolean
  /**
   * Hook cards (executions / deny-ask decisions / halts) that fired during this
   * message's turn (decision 10). **Display-only and derived** — populated at
   * fold time from the thread's always-on spine `hook_run` records (decision 6)
   * and appended live from the `hook_run` stream chunk. Never persisted via the
   * message explode path: the spine's `hook_run` lines are the single source of
   * truth, so this resolves purely from spine data (decision 17), never from live
   * hook registration.
   */
  hookCards?: HookCard[]
  createdAt: number
}

export interface UsageDelta extends ModelUsage {
  model: string
  /**
   * When set, the usage ledger records this source instead of `'agent'`.
   * Must match StreamChunk usage `usageSource` so main+renderer dual-writes dedupe.
   */
  usageSource?: 'advisor'
}
