import type { ModelParameters, ReasoningLevel } from '@copse/llm/model-parameters.ts'
import type { CanvasArtefactReference } from './canvas-types.ts'
import type { RemoteAgentLink } from './remote-agent-link.ts'
import type { GithubPrRef } from './github-pr-url.ts'
import type { HookCard } from './hook-card.ts'
import type { ThreadWorktree, ThreadWorktreeChoice } from './worktree-types.ts'
import type { ThreadProposalDecision } from './thread-proposal.ts'
import type { ArchiveAttachmentRef, VideoAttachmentRef } from './attachment-refs.ts'
import type { TurnOutcome } from './turn-outcome.ts'
export type { HookCard } from './hook-card.ts'
// Token-usage types are owned by the LLM module (a provider reports usage across
// the contract). Imported for use by the thread types below and re-exported so
// `@shared/types` consumers are unchanged.
import type { ModelUsage, ThreadUsage } from '@copse/llm/wire-types.ts'
import type { ServiceTier } from '@copse/llm/service-tier.ts'
export type { ModelUsage, ThreadUsage } from '@copse/llm/wire-types.ts'
// The subagent session/tool-call record and the context-breakdown shapes are
// owned by the agent module (the loop constructs sessions and reports the
// breakdown); imported for the thread types below and re-exported so
// `@shared/types` consumers are unchanged.
import type {
  AcpContentBlock,
  AgentRunPayload,
  TodoItem,
  ToolCall,
} from '@copse/agent/wire-types.ts'
export type {
  AcpContentBlock,
  AcpToolCallContent,
  AcpToolCallLocation,
  ToolCall,
  SubagentMessage,
  SubagentSession,
  ContextSegmentKey,
  ContextBreakdownSegment,
  ContextBreakdown,
} from '@copse/agent/wire-types.ts'

export type ThreadStatus = 'idle' | 'running' | 'error'

/** Durable attribution for one committed thread-model selection. */
export interface ModelSelectionEvent {
  id: string
  recordedAt: number
  by: 'user' | 'auto'
  from?: string
  to: string
}

// Hook provenance is owned by the hooks platform in `@copse/agent` (decision 10);
// imported for the message types below and re-exported so `@shared/types`
// consumers are unchanged.
import type { QueuedMessageOrigin } from '@copse/agent/hooks/hook-outcome.ts'
export type { QueuedMessageOrigin } from '@copse/agent/hooks/hook-outcome.ts'

/** Provenance for a host-native continuation that started without a human submit. */
export interface MachineMessageOrigin {
  kind: 'machine'
  /** Durable background/supervisor operation that requested the continuation. */
  operationId: string
}

/** Authorship marker persisted on transcript messages. */
export type MessageOrigin = QueuedMessageOrigin | MachineMessageOrigin

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
  /** Present when the context owner reported this snapshot directly. */
  source?: 'agent-reported'
  /** Cumulative cost reported by the ACP session, in the agent's ISO currency. */
  cost?: { amount: number; currency: string }
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
 * Result of the retired model-comparison harness (two reviewers and a judge
 * comparing their prose). Nothing produces one any more; the type stays so a
 * thread that carries one from before Copse Reviewer still renders its card
 * (hooks-and-feature-packs decision 17: disabling or replacing a pack never
 * breaks history).
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

/**
 * What a review finding could stand on — the app-side projection of
 * `@copse/review`'s evidence union, carried verbatim so the card can quote the
 * command, the reproducer or the cited lines.
 */
export type ReviewFindingEvidence =
  | {
      kind: 'command'
      /** The argv that ran, shell-quoted for display. */
      command: string
      target: 'base' | 'head'
      /** `null` when the process was killed rather than exiting. */
      exitCode: number | null
      /** Capped, secret-scrubbed tail of the output. */
      excerpt: string
    }
  | { kind: 'reproducer'; testPath: string; failsOnHead: boolean; passesOnBase: boolean }
  | { kind: 'citation'; path: string; startLine: number; endLine: number }

/**
 * One finding as the findings card shows it: `@copse/review`'s `Finding`
 * flattened for rendering, plus the source lines it is anchored to and whether
 * the user has dismissed it. The `id` is the reviewer's content-derived
 * identity, which is what a persisted dismissal is keyed by, so a finding stays
 * dismissed across pushes as long as the anchored source and the claim hold.
 */
export interface ReviewFindingRecord {
  id: string
  path: string
  startLine?: number
  endLine?: number
  /** One sentence, falsifiable. */
  claim: string
  /** A class from the reviewer's B4 list (`build`, `type`, `test`, `contract`, …). */
  class: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  confidence: 'low' | 'medium' | 'high'
  verdict: { status: 'confirmed' | 'refuted' | 'unverified'; reason: string }
  /** Reviewer labels: `stage0`, or `model (lens)`. */
  raisedBy: string[]
  corroboratedBy: string[]
  challengedBy: string[]
  evidence: ReviewFindingEvidence[]
  /** The lines the anchor covers on head, when the file could be read. */
  anchoredText?: string
  /** Set when the user dismissed this finding (persisted in the knowledge store). */
  dismissed?: boolean
}

/** One reviewer turn (a model under a lens), as the card lists them. */
export interface ReviewReportReviewer {
  model: string
  lens: string
  /** The headless contract's turn outcome. */
  outcome: 'completed' | 'failed' | 'cancelled' | 'awaiting_approval' | 'awaiting_input'
  candidates: number
  summary: string
  error?: string
}

/**
 * The Copse Reviewer report for a thread, as produced by a "Review" gesture
 * (the Changes view, the follow-up bubble or the `review_changes` tool).
 * Replaces the model comparison as the thread's trailing card: findings, not
 * prose — each one addressable, evidenced and dismissible.
 */
export interface ThreadReviewReport {
  status: 'running' | 'done' | 'error'
  /** When the run started (ms since epoch). */
  startedAt: number
  /** The reviewer model, and the challenger/reproducer model when verification ran. */
  models: { reviewer: string; challenger: string | null }
  lenses: string[]
  /** What the head was reviewed against. */
  baseRef: string
  headCommit: string | null
  dirtyWorkingTree: boolean
  /**
   * Whether anything from the repository was executed, behind which boundary,
   * and why not when it was not. A review without execution is read-only:
   * Stage 0 did not run and the reviewer had no `run_command`.
   */
  execution: { backend: string; strength: string; executed: boolean; reason: string }
  /** Stage 0's per-check verdicts on head. */
  checks: { kind: string; verdict: string }[]
  /** Why some or all of Stage 0 did not run. */
  notChecked: string[]
  /** Ranked and capped; `appendix` counts the rest. */
  findings: ReviewFindingRecord[]
  appendix: number
  /** Candidates the challenger refuted; never surfaced, counted so the card can say so. */
  refuted: number
  reviewers: ReviewReportReviewer[]
  verification: {
    attempted: number
    confirmed: number
    refuted: number
    survived: number
    undetermined: number
    skipped: number
  } | null
  durationMs: number
  /** Human-readable cost estimate for the whole run (e.g. `~$0.04`). */
  cost?: string
  /** A completed run with a caveat worth one line, e.g. no changes against the base. */
  note?: string
  /** Populated when `status === 'error'`. */
  error?: string
}

export interface Thread {
  id: string
  title: string
  /**
   * How many times auto-naming has written {@link title}. Absent means the title
   * is nobody's but the user's — either the untouched `New Thread` default or a
   * manual rename — so auto-naming must leave it alone. Present means the title
   * is ours to refine as the thread grows, up to a small fixed number of passes.
   */
  autoTitleCount?: number
  status: ThreadStatus
  messages: Message[]
  /**
   * `false` means this thread's transcript has not been read off disk yet, so an
   * empty `messages` says nothing about whether the thread has any.
   *
   * Load-bearing, not cosmetic. `isBlankThread` treats an empty transcript as
   * "new, unused thread", `pruneBlankThreads` drops those from the store, and
   * the autosave reconciler then deletes anything that left — so without this
   * flag a metadata-only load would delete a project's entire history on its
   * first launch. `undefined` means "loaded" (threads built in memory, and the
   * demo API's whole threads).
   *
   * Never persisted: both `metaOf` implementations strip it before writing.
   */
  messagesLoaded?: boolean
  /**
   * GitHub PRs linked from this thread, cached on its metadata.
   *
   * Derived from PR links in message text plus {@link remoteAgentLink} — that
   * is, from exactly the transcript a metadata-only load does not read. Caching
   * the scrape's result here is what lets the sidebar draw its PR chip without
   * the transcript, and it is refreshed whenever the transcript is in memory
   * (on append, and on hydration).
   */
  prRefs?: GithubPrRef[]
  usage: ThreadUsage
  /** Populated when history compaction runs during an agent turn (also in JSONL export). */
  contextTrims?: ContextTrimRecord[]
  /** Latest context fill estimate while the agent is running (or after the last run). */
  contextSnapshot?: ContextSnapshot
  /** Structured task plan for multi-step agent work (updated via update_todos). */
  todos?: TodoItem[]
  /**
   * A two-model comparison from before Copse Reviewer replaced the harness.
   * Never written any more; kept so old threads still render their card.
   */
  comparison?: ModelComparison
  /** Latest Copse Reviewer report for this thread's changes (replaces `comparison`). */
  reviewReport?: ThreadReviewReport
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
   * run seeds the main-process ledger with this so its in-run tighteners (ACP
   * unfinished-turn recovery / closeout / pre-review / remediation) share one
   * counter per turn tree.
   */
  continuationUsed?: number
  /** True while a queued message is being edited; suspends FIFO draining. */
  queuePaused?: boolean
  /** Unsubmitted composer text; keeps blank threads visible across switches. */
  draftPrompt?: string
  /** Latest agent completion that happened while this thread was not selected. */
  unreadAt?: number
  /** Per-thread model override; absent means "use the global default". */
  model?: string
  /** Ordered picker/automatic model changes, mirrored in the thread spine. */
  modelSelections?: ModelSelectionEvent[]
  /**
   * The concrete model a turn's `model` selector expanded to (e.g.
   * `auto:…` → `gpt-5.6-terra`). Recorded at resolution time so it survives a
   * turn that fails before any usage, unlike the live `byModel` usage map.
   * Absent on threads written before this was captured.
   */
  resolvedModel?: string
  /**
   * Per-chat reasoning dial, set from the composer footer. Overrides the level
   * saved against the model in Settings for this chat's turns only, so "this
   * one's hard, think harder" does not permanently re-tune the model. Absent
   * means the model's own saved level applies.
   */
  reasoning?: ReasoningLevel
  /**
   * Answers to the {@link ThreadProposal}s the agent offered in this thread —
   * one row per proposal, keyed by the offering tool call's id (see
   * `thread-proposal.ts`). Absent means every offer in the transcript is still
   * a standing offer, which is the resting state, not a pending prompt.
   *
   * Kept on the *offering* thread rather than derived from whether a started
   * thread still exists: deleting the thread a proposal created must not put
   * the card back to "start this?", and a dismissal has no thread to derive it
   * from at all.
   */
  threadProposals?: ThreadProposalDecision[]
  /** Provenance for a thread the user started from a model-authored proposal. */
  proposedBy?: {
    /** Thread whose transcript carries the offering `propose_thread` call. */
    threadId: string
    /** {@link ThreadProposal.id} — the offering tool call. */
    proposalId: string
  }
  /** Provenance for a task created by a project automation schedule. */
  automation?: {
    scheduleId: string
    scheduleName: string
    triggeredAt: number
  }
  /**
   * Videos the user has attached to this thread, in the order they were sent.
   *
   * Recorded on send (not on chip creation), so a video attached and then
   * removed before sending never counts. Two things read it: `video_frames` is
   * only offered to the model on threads that have one, and the paths are
   * restated in the tool's description every turn — the reference block in the
   * user's message is the only other place they appear, and history trimming
   * can drop it out from under a long conversation.
   */
  videos?: VideoAttachmentRef[]
  /**
   * Archives (zips) the user has attached to this thread, in the order they
   * were sent. Read the same two ways `videos` is: `read_archive` is only
   * offered on threads that have one, and the paths are restated in the tool's
   * description every turn so trimming cannot lose them.
   */
  archives?: ArchiveAttachmentRef[]
  /**
   * When set, the thread is archived: hidden from the sidebar and `@`-thread
   * catalog, but kept on disk under `~/.copse/workspace/<projectId>/<id>/`.
   * Soft-hide (not a delete) — restore is a later UI concern.
   */
  archivedAt?: number
  /**
   * When a human last prompted this thread — the sidebar's default sort key.
   *
   * Metadata rather than something read off the transcript, for the same reason
   * {@link prRefs} is: the sidebar loads threads metadata-only, so a key derived
   * from `messages` would be unavailable for exactly the threads it has to
   * order. Set as each human prompt lands; absent on threads written before this
   * existed, which fall back to `createdAt` until their transcript is next read
   * (see `lastHumanPromptAt`).
   *
   * Only human prompts count — a hook or machine continuation carries a
   * {@link MessageOrigin} and does not move the thread up the sidebar, so an
   * overnight automation cannot reorder the list under the user. Agent activity
   * on an unselected thread is surfaced by {@link unreadAt} instead.
   */
  lastPromptAt?: number
  createdAt: number
  updatedAt: number
}

/**
 * How a fork's provider-format history was seeded from the thread it branched
 * off (`threads:fork`). `copied` is the source sidecar verbatim — the
 * highest-fidelity result. `rebuilt` was reconstructed from the copied
 * transcript slice, which cannot carry content that only existed in the run
 * payload (the fenced blocks inlined for `@`-file / `@`-thread / shell chips).
 * `empty` means the source had neither recorded provider history nor a visible
 * transcript that could be rebuilt.
 */
export interface ForkedHistoryResult {
  source: 'copied' | 'rebuilt' | 'empty'
  messageCount: number
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
  /**
   * Copy of the thread meta's {@link Thread.prRefs}, so "find the thread that
   * opened #2262" is answerable from the index alone. Required, not optional:
   * a line without it is a pre-`prRefs` catalog, and dropping such lines on read
   * is what makes the whole file rebuild itself (see `readCatalog`). `[]` means
   * "indexed, no PRs" — the same convention `backfillThreadPrRefs` uses on meta.
   */
  prRefs: GithubPrRef[]
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
 * purely how the sent message renders. Positional `paste`/`thread` attachments
 * lead the array and map, in order, to U+FFFC (object-replacement) placeholders
 * in the message `content`; remaining attachments render in a trailing row.
 */
export interface TranscriptAttachment {
  kind: 'paste' | 'file' | 'thread' | 'shell' | 'video' | 'archive'
  label: string
  /**
   * Exact text snapshot represented by a text-like chip. Persisted out-of-line
   * in the thread store so the sent attachment remains inspectable even when a
   * workspace file later changes. Absent for non-text and legacy attachments.
   */
  content?: string
  /**
   * Where the attached file lives, for the chips that can act on it. Set by
   * `video` (the chip plays the recording in a preview modal) and `archive`
   * (the path is what the agent unpacks) — in both cases the label alone, a
   * bare filename, cannot find the file again after a reload. Absent for every
   * other kind, which are display-only.
   */
  path?: string
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
  /** Non-text ACP assistant content, kept out of the Markdown body. */
  contentBlocks?: AcpContentBlock[]
  /** Non-text ACP thought content, rendered inside the reasoning disclosure. */
  reasoningBlocks?: AcpContentBlock[]
  /** Pasted image attachments as data URLs (user messages only). */
  images?: string[]
  toolCalls: ToolCall[]
  /** Canvas previews presented with this answer without fabricating tool calls. */
  canvasArtefacts?: CanvasArtefactReference[]
  /** Small-model rollup label for this message's batch of shell commands. */
  commandSummary?: string
  /**
   * Small-model polish for the turn's tool rollup (`.tool-card-rollup`). The
   * deterministic canned label shows immediately; this replaces it when ready
   * and never blocks delivery.
   */
  toolSummary?: string
  /**
   * Small-model polish for the *run* this message anchors — the rollup that
   * spans this message and the tool-only assistant messages that follow it.
   * Only ever set on a run's anchor, and only once the run spans more than one
   * message; {@link Message.toolSummary} stays this message's own label and is
   * shown as its step heading inside the run.
   */
  runSummary?: string
  /**
   * Primary-chat model that produced this assistant message — the concrete
   * route actually run, after a dynamic selector (`auto:…`) was expanded.
   * Surfaced in the transcript only when the thread used more than one primary
   * model — subagent models live on {@link SubagentSession.model}.
   */
  model?: string
  /**
   * The model the user asked for for this turn — the picker/requested
   * selection, which may be a dynamic selector (`auto:…`) rather than a
   * concrete route. The resolved route the turn actually ran on lives on
   * {@link Message.model}. Absent on messages written before this was captured.
   */
  requestedModel?: string
  /**
   * Generation parameters this turn actually ran with — resolved, not
   * configured: the model's saved values after sanitizing for what it accepts,
   * with a per-chat dial applied over them and a cheap role's ceiling applied
   * under them. Recorded because the configuration is mutable and the resolved
   * value can differ from it, so without this a transcript re-reads as though
   * every past turn ran at whatever Settings says today. Absent when the turn
   * sent no parameters at all, which is the common case.
   */
  parameters?: ModelParameters
  /** Structured terminal state for diagnostics and portable thread exports. */
  turnOutcome?: TurnOutcome
  /**
   * Post-turn review verdict for the editing turn this message concluded. Set on
   * the turn's final assistant message so the review joins the transcript inline
   * (in position, one per reviewed turn) rather than as a single trailing card.
   */
  review?: ThreadReview
  /**
   * Provenance when this turn was started without a human submit. The
   * message role stays `user` for the LLM; `origin` lives purely in the data
   * model so the transcript can mark a hook-originated turn (a hook send-now /
   * `stop`-follow-up that dispatched). Carried through the spine so the marker
   * survives a reload (history stays honest about authorship). `editedByUser`
   * flips `true` once a human edits a hook-queued message before it dispatches.
   */
  origin?: MessageOrigin
  editedByUser?: boolean
  /**
   * Repository state this prompt started from (user messages only), captured at
   * send time. `startingCommit` is the HEAD SHA the turn began on; `dirty`
   * records whether the working tree had uncommitted changes at that moment.
   * Best-effort: absent outside a git repo, or for messages sent through a path
   * that doesn't capture it (e.g. resend).
   */
  startingCommit?: string
  dirty?: boolean
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
  requestedServiceTier?: ServiceTier
  responseServiceTier?: ServiceTier
}

/**
 * A thread-store directory under `~/.copse/workspace/<id>/` that has no matching
 * project entry in config — threads that would otherwise be invisible. Surfaced
 * so they can be re-attached to a folder rather than recovered by hand (#997).
 */
export interface OrphanProjectStore {
  /** The store directory id (also the project id it would re-attach under). */
  id: string
  /** How many thread directories the store holds. */
  threadCount: number
}
