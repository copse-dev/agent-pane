// Canonical events — the registry's event taxonomy (A1 of the hooks platform).
//
// A *canonical event* is a named point where the harness calls the registry
// (glossary, docs/plans/hooks-and-feature-packs.md). Harness code fires
// canonical events only; it never knows dialects or executor kinds exist. The
// event names are final — changing one is a decisions-log edit, not a refactor.
//
// M0.1 shipped only the two blocking *assembly* events (`turnStart`,
// `beforeFinalize`). A1 extends the catalogue to the full "Canonical events
// (v1 enumeration)" table: every canonical event is *typed and registered* here
// even though most fire sites land in later phases (the Phase column of that
// table). Typing them now lets later phases fill payloads and wire fire sites
// without ever widening the `HookEventName` union — the union is the frozen
// contract; the fire sites are the incremental work.
import type { TodoItem } from '../wire-types.ts'
import type { AgentStreamChunk } from '../wire-types.ts'
import type { BlockingHookOutcome, AsyncHookOutcome, HookDecision } from './hook-outcome.ts'
import type { CommandHookRunner } from './command-executor.ts'

// ---------------------------------------------------------------------------
// Event payloads
//
// One payload interface per canonical event. Shapes are deliberately *minimal*:
// each carries only what its documented fire site already has in hand, enough
// for the phase that wires it to extend without changing the event name. Where
// a field is genuinely unknown until the wiring phase, the interface stays lean
// rather than guessing — a smaller true shape beats a wide speculative one.
// ---------------------------------------------------------------------------

/**
 * Payload for `turnStart` (M0). Steering hooks read the raw user text to decide
 * which prompt blocks to add and see the carried-over todos for the prior-todos
 * pin.
 */
export interface TurnStartPayload {
  /** Raw user message text used for steering decisions (redaction-independent). */
  userText: string
  /** Todos carried over from prior turns (drives the prior-todos pin). */
  priorTodos: readonly TodoItem[]
}

/**
 * Payload for `beforeFinalize` (M0). The closeout hook escalates its nudge after
 * the first attempt, so the attempt index travels with the still-open todos.
 */
export interface BeforeFinalizePayload {
  /** Todos still open (pending / in_progress) at the finalize checkpoint. */
  openTodos: readonly TodoItem[]
  /** Zero-based closeout attempt index; nudge text escalates after the first. */
  attempt: number
}

/**
 * Payload for `beforeSubmitPrompt` (B1). Fires on the compose path before
 * `agent:run`; a blocking decision hook may rewrite or halt (`continue: false`).
 */
export interface BeforeSubmitPromptPayload {
  /** The composed prompt text about to be submitted. */
  prompt: string
}

/**
 * Payload for `toolGate` (A2). The single canonical gate that Cursor's
 * `beforeShell`/`beforeMCP`/`beforeReadFile` and Claude's `PreToolUse` all map
 * onto. `updatedInput` (H1) rewrites `input`, which re-runs policy analysis.
 */
export interface ToolGatePayload {
  /** Canonical tool name being gated (e.g. `run_shell`, an MCP tool id). */
  toolName: string
  /** Tool input the model proposed; the value a rewrite (`updatedInput`) edits. */
  input: Record<string, unknown>
  /**
   * File contents for a `read_file` gate (Cursor `beforeReadFile` `content`), so
   * a redaction / secret-detection hook can inspect the bytes and deny before
   * they reach the model (B4). Absent for non-read gates and when the file could
   * not be read; the host fills it at the fire site (the read happens after the
   * gate, so the host reads it eagerly for read_file when hooks are enabled).
   */
  fileContent?: string
}

/**
 * Payload for `afterFileEdit` (B2). Blocking by default (formatters mutate),
 * async opt-in per hook — see {@link HookEventSpec.asyncOptIn}.
 */
export interface AfterFileEditPayload {
  /** Absolute path of the file that was edited. */
  filePath: string
}

/**
 * Payload for `stop` (B3). Fires the moment agent work halts — turn end or
 * abort — with the terminal status. Detached (decision 3): never awaited.
 */
export interface StopPayload {
  /** Why agent work stopped: normal turn end or an abort/halt. */
  status: 'completed' | 'aborted'
}

/**
 * Payload for `afterToolUse` (D2). The generic post-tool observation; shell/MCP
 * variants are payload flavors, not separate event names.
 */
export interface AfterToolUsePayload {
  /** Canonical tool name that just ran. */
  toolName: string
  /** The tool call this result belongs to. */
  toolCallId: string
  /** Whether the tool reported an error. */
  isError: boolean
}

/**
 * Payload for `subagentStart` (D1). A blocking decision hook may deny the spawn
 * (matcher on subagent type).
 */
export interface SubagentStartPayload {
  /** The subagent type/kind about to be spawned (matcher target). */
  subagentType: string
}

/**
 * Payload for `subagentStop` (D1). Detached; follow-ups route through the queue
 * + budget (C2/C3), never a bespoke protocol.
 */
export interface SubagentStopPayload {
  /** The subagent type/kind that finished. */
  subagentType: string
}

/**
 * Payload for `sessionStart` (H4). Fire-and-forget on a new thread / first turn;
 * an outcome's `sessionEnv` propagates to later hook processes.
 */
export interface SessionStartPayload {
  /** True when this is the thread's first turn. */
  firstTurn: boolean
}

/**
 * Payload for `compaction` (later). Async observation fired when history is
 * trimmed or compacted at a todo boundary.
 */
export interface CompactionPayload {
  /** What triggered the compaction. */
  trigger: 'history-trim' | 'todo-boundary'
}

/**
 * Payload for `permissionDecision` (F2). Async observation fired after the
 * permission verdict is decided; feeds #840's audit trail.
 */
export interface PermissionDecisionPayload {
  /** Canonical tool name the verdict applies to. */
  toolName: string
  /** The verdict `decideShellPermission` (or an adapter) produced. */
  decision: HookDecision
}

/**
 * Payload for `beforeDiffApply` (F2, Copse-native). Blocking approval point in
 * the diff-queue flow; a hook may deny/halt before the edit lands.
 */
export interface BeforeDiffApplyPayload {
  /** Absolute path of the file the queued diff targets. */
  filePath: string
}

/**
 * Payload for `afterDiffApply` (F2, Copse-native). Async observation fired once
 * a queued diff has been applied (or rejected).
 */
export interface AfterDiffApplyPayload {
  /** Absolute path of the file the diff targeted. */
  filePath: string
  /** Whether the queued diff was applied (vs rejected). */
  applied: boolean
}

/**
 * Payload each canonical event delivers to its hooks, keyed by event name. The
 * key set is the source of truth: {@link HOOK_EVENT_NAMES} and
 * {@link HOOK_EVENT_SPECS} are pinned against it, so adding an event here
 * forces the name list and spec table to stay complete (compile error otherwise).
 */
export interface HookEventPayloads {
  turnStart: TurnStartPayload
  beforeFinalize: BeforeFinalizePayload
  beforeSubmitPrompt: BeforeSubmitPromptPayload
  toolGate: ToolGatePayload
  afterFileEdit: AfterFileEditPayload
  stop: StopPayload
  afterToolUse: AfterToolUsePayload
  subagentStart: SubagentStartPayload
  subagentStop: SubagentStopPayload
  sessionStart: SessionStartPayload
  compaction: CompactionPayload
  permissionDecision: PermissionDecisionPayload
  beforeDiffApply: BeforeDiffApplyPayload
  afterDiffApply: AfterDiffApplyPayload
}

/**
 * Every canonical event name (A1's full v1 enumeration). Order is
 * registration-neutral; it follows the plan's table top-to-bottom for readability.
 * Names are final — changing one is a decisions-log edit, not a refactor.
 */
export const HOOK_EVENT_NAMES = [
  'turnStart',
  'beforeFinalize',
  'beforeSubmitPrompt',
  'toolGate',
  'afterFileEdit',
  'stop',
  'afterToolUse',
  'subagentStart',
  'subagentStop',
  'sessionStart',
  'compaction',
  'permissionDecision',
  'beforeDiffApply',
  'afterDiffApply',
] as const

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number]

/** How the harness dispatches an event: awaited in the critical path, or detached. */
export type HookDispatch = 'blocking' | 'async'

/** What an event is for: assembles the prompt, decides an action, or observes. */
export type HookRole = 'assembly' | 'decision' | 'observation'

export interface HookEventSpec {
  name: HookEventName
  /**
   * Default dispatch (the "Kind" column). Blocking events run in the harness's
   * critical path; async events are detached (decision 3, never awaited).
   */
  dispatch: HookDispatch
  role: HookRole
  /**
   * True for events a hook may opt into running async even though the default
   * is blocking (`afterFileEdit`: blocking for formatters, async opt-in for
   * pure observers — decision 2). Absent means the dispatch is fixed.
   */
  asyncOptIn?: boolean
}

/**
 * Static metadata for every canonical event, mirroring the plan's "Kind" column.
 * The `Record<HookEventName, …>` key type makes a missing entry a compile error,
 * so this table stays complete as the union above grows.
 */
export const HOOK_EVENT_SPECS: Record<HookEventName, HookEventSpec> = {
  turnStart: { name: 'turnStart', dispatch: 'blocking', role: 'assembly' },
  beforeFinalize: { name: 'beforeFinalize', dispatch: 'blocking', role: 'assembly' },
  beforeSubmitPrompt: { name: 'beforeSubmitPrompt', dispatch: 'blocking', role: 'decision' },
  toolGate: { name: 'toolGate', dispatch: 'blocking', role: 'decision' },
  afterFileEdit: {
    name: 'afterFileEdit',
    dispatch: 'blocking',
    role: 'decision',
    asyncOptIn: true,
  },
  stop: { name: 'stop', dispatch: 'async', role: 'observation' },
  afterToolUse: { name: 'afterToolUse', dispatch: 'async', role: 'observation' },
  subagentStart: { name: 'subagentStart', dispatch: 'blocking', role: 'decision' },
  subagentStop: { name: 'subagentStop', dispatch: 'async', role: 'observation' },
  sessionStart: { name: 'sessionStart', dispatch: 'async', role: 'observation' },
  compaction: { name: 'compaction', dispatch: 'async', role: 'observation' },
  permissionDecision: { name: 'permissionDecision', dispatch: 'async', role: 'observation' },
  beforeDiffApply: { name: 'beforeDiffApply', dispatch: 'blocking', role: 'decision' },
  afterDiffApply: { name: 'afterDiffApply', dispatch: 'async', role: 'observation' },
}

/**
 * What the registry reports to the host about one *function-hook* execution
 * (decision 6 spine recording). The registry knows the event, the hook, the
 * timing, and the outcome; the *host* owns attribution (thread/turn/step) and
 * persistence — this record deliberately carries none of that, which is what
 * keeps `packages/agent` free of any persistence import.
 *
 * Command (spawned) hooks are *not* recorded through this sink: their runner
 * lives host-side, owns the process, and records stdout/stderr/exit-code
 * directly (`recordCommandHookRun`). This record is therefore the function-hook
 * shape — no exit code, no stream blobs.
 */
export interface HookRunRecord {
  event: HookEventName
  hookId: string
  startedAt: number
  durationMs: number
  /** The outcome the hook returned; null when it abstained or threw. */
  outcome: BlockingHookOutcome | null
  /** Set when the hook threw. Fail-hard semantics still apply — recording happens first. */
  error?: string
}

// ---------------------------------------------------------------------------
// Hook context + executor capability split (decision 15)
//
// Two executor kinds, two capability tiers. The *base* context is what any hook
// dispatch is handed. First-party FUNCTION hooks additionally receive
// `emitChunk` (typed `AgentStreamChunk`) and `loopState` (read live loop state)
// via {@link FunctionHookContext}. Command (spawned) hooks are executed by the
// host-injected {@link CommandHookRunner}, which is handed only the *base*
// context — so a command hook can never emit feature chunks or read loop state.
// That boundary is the type-level enforcement of decision 15: the typed stream
// stays first-party, which keeps transcripts trustworthy.
// ---------------------------------------------------------------------------

/**
 * A read-only view of live loop state exposed to first-party function hooks
 * (decision 15). Deliberately narrow and immutable: hooks *read* loop state,
 * they never mutate it directly (their influence is the returned outcome).
 * Later phases widen this as function hooks need more.
 */
export interface HookLoopState {
  /** LLM-call index at the fire point (0 = before the first call). */
  readonly step: number
  /** Todos as the loop currently sees them. */
  readonly todos: readonly TodoItem[]
}

/**
 * Cross-cutting services and signals every hook dispatch receives alongside its
 * event payload — the capabilities shared by *both* executor kinds. First-party
 * function hooks receive app services here (never by importing them), which is
 * what keeps `packages/agent` Electron-free (execution-guidance rule 4).
 */
export interface HookContext {
  /** Abort signal for the current run; hooks should bail out if it fires. */
  signal?: AbortSignal
  /**
   * Resolve the workspace GitHub `org/repo` slug, or null when the remote is
   * missing / not GitHub. Provided by the host so `github-link-steering` never
   * imports the app's git service.
   */
  resolveGithubRepoSlug?: () => Promise<string | null>
  /**
   * Spine-recording sink (decision 6, always-on when the host provides it).
   * Called once per hook execution, including executions that throw. Injected
   * by the app — the registry never imports persistence. Must be treated as
   * fire-and-forget observability: the registry swallows sink errors so
   * recording can never change loop behavior.
   */
  recordHookRun?: (record: HookRunRecord) => void
  /**
   * Host-injected runner for command (spawned-process) hooks. `packages/agent`
   * defines the interface; the concrete spawn lives in
   * `src/main/services/hooks/` (execution-guidance rule 4). Absent in pure
   * package tests / hosts with no command support — a command hook fired with no
   * runner is skipped, never a hard failure.
   */
  runCommandHook?: CommandHookRunner
  /**
   * Agent-session identity (real conversation / generation ids + running model)
   * the host captures at the fire site and dialect adapters stamp onto wire
   * payloads (B4). Opaque to `packages/agent`; absent outside an active run (the
   * marshaller then emits empty ids, as it did before B4). Captured **by value**
   * at dispatch so a detached `stop` hook still marshals the finished turn's
   * identity even after the run's recording context is torn down (decision 3).
   */
  agentSession?: AgentSessionInfo
}

/**
 * The context a first-party FUNCTION hook receives — the base context plus the
 * two first-party-only capabilities of decision 15. Command hooks never see
 * these fields (their runner is handed a bare {@link HookContext}), so emitting
 * a typed chunk or reading loop state from a command hook is a compile error,
 * not a review comment.
 */
export interface FunctionHookContext extends HookContext {
  /**
   * Emit a typed {@link AgentStreamChunk} (feature chunks like `todo_update`,
   * `subagent_*`). First-party only — external command hooks can never emit
   * feature chunks (decision 15), which is why this lives on the function
   * context alone.
   */
  emitChunk?: (chunk: AgentStreamChunk) => void
  /** Read-only view of live loop state (decision 15). */
  loopState?: HookLoopState
}

/**
 * One selected model parameter, as the Cursor agent-session wire contract shapes
 * them: `model_params` is an **array** of `{ id, value }` string pairs (e.g.
 * `{ id: 'context', value: '1m' }`), not an object (B4; Cursor hooks reference).
 */
export interface HookModelParam {
  id: string
  value: string
}

/**
 * The identity of the model actually running a turn, stamped onto every Cursor
 * agent-session wire payload (B4; vendor contract `model` / `model_id` /
 * `model_params`). Sourced host-side from thread-model tracking + the resolved
 * run model (incl. a subagent's local fallback once D1 wires subagent hooks).
 */
export interface HookAgentSessionModel {
  /** Legacy model slug configured for the run (Cursor `model`). */
  model: string
  /** Structured id for the selected model (Cursor `model_id`). */
  modelId: string
  /** Selected model parameters as `{ id, value }` pairs (Cursor `model_params`). */
  modelParams: HookModelParam[]
}

/**
 * The agent-session identity a dialect adapter stamps onto a wire payload (B4):
 * the real conversation / generation ids from the active run and the running
 * model. `packages/agent` treats this as opaque pass-through data — the host
 * builds it (from thread id / turn id / resolved model) and threads it through
 * {@link HookContext.agentSession}; only host-side dialect adapters read it, and
 * only the Cursor dialect stamps `model` on agent-session events (Claude carries
 * an optional `model` on `sessionStart` only, per its contract — H4 fire site).
 */
export interface AgentSessionInfo {
  /** Stable conversation id across turns — Cursor `conversation_id` (thread id). */
  conversationId: string
  /** The generation that changes each turn — Cursor `generation_id` (turn id). */
  generationId: string
  /** Running model identity; absent when unknown (e.g. no active run). */
  model?: HookAgentSessionModel
}

type MaybePromise<T> = T | Promise<T>

/**
 * A first-party *blocking* function hook: an in-process function that runs in
 * the harness's critical path. Fail-hard (decision 9) — a throw is a bug,
 * surfaced loudly, never swallowed into an allow.
 */
export type BlockingHookFn<E extends HookEventName = HookEventName> = (
  payload: HookEventPayloads[E],
  context: FunctionHookContext,
) => MaybePromise<BlockingHookOutcome | undefined>

/**
 * A first-party *async* (detached) function hook. No async canonical events are
 * wired yet (Phase C owns detached dispatch), but the executor-kind + outcome
 * split exists from day one so decisions 4 & 11 are enforced by the compiler the
 * moment async events land.
 */
export type AsyncHookFn<E extends HookEventName = HookEventName> = (
  payload: HookEventPayloads[E],
  context: FunctionHookContext,
) => MaybePromise<AsyncHookOutcome | undefined>

/** A registered first-party blocking function hook: a stable id, its event, and its handler. */
export interface BlockingHook<E extends HookEventName = HookEventName> {
  /** Stable id for spine attribution, the Sources UI, and dedup. */
  id: string
  /** Canonical event this hook subscribes to. */
  event: E
  // Method syntax (bivariant params) lets hooks for different events share one
  // storage list in the registry without a cast; the public `register`/`emit`
  // surface preserves per-event type safety at the boundaries. A hook with no
  // opinion returns `undefined` (the house style bans `void` in a union).
  run(
    payload: HookEventPayloads[E],
    context: FunctionHookContext,
  ): MaybePromise<BlockingHookOutcome | undefined>
}

/**
 * A registered first-party *async* (detached) function hook (C1). Dispatched
 * through the detached executor — never awaited (decision 3) — so it can only
 * return an {@link AsyncHookOutcome}: no `decision` / `updatedInput` /
 * `injectContext` at the type level (decisions 4 & 11). Its output channel is the
 * pending-message queue (C2), so C1 collects any outcome to a host callback stub
 * without wiring the queue. Method syntax matches {@link BlockingHook} so hooks
 * for different events co-store without a cast.
 */
export interface AsyncHook<E extends HookEventName = HookEventName> {
  /** Stable id for spine attribution, the Sources UI, and dedup. */
  id: string
  /** Canonical event this hook subscribes to. */
  event: E
  run(
    payload: HookEventPayloads[E],
    context: FunctionHookContext,
  ): MaybePromise<AsyncHookOutcome | undefined>
}
