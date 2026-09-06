// Host-side command-hook runner — the concrete spawn seam (A1 stub → A2 real).
//
// `packages/agent` defines the executor contract (`CommandHookRunner`,
// `CommandHook`, `CommandHookResult`) and stays Electron-free; the *concrete*
// process spawn, dialect wire marshalling both directions, per-event exit-code
// tables, and per-dialect failure resolution live here (execution-guidance rule
// 4). This is the module the app injects into `HookContext.runCommandHook`, so
// registry command hooks actually spawn.
//
// The runner is dialect-agnostic: it looks a hook's `dialect` up in the adapter
// registry and delegates marshalling + interpretation. The only failure policy
// it owns is decision 9's uniform resolution — a `failed` run becomes `deny`
// under `onFailure: closed` (Cursor `failClosed: true`) or a no-op under
// `onFailure: open` (the vendor default). A dialect that treats a signal as a
// *decision* (Claude exit-2 deny) reports it as a non-failed outcome, so it is
// never routed through this resolution.
//
// F3 (decision 7) adds one more dialect-agnostic escalation the runner owns:
// a hook that ran inside the project sandbox and was blocked by it (runner-side
// violation signals — never the hook's stdout, issue #104) is turned into a
// `failed` run via {@link applySandboxBlock}, so the block flows through the
// same `onFailure` resolution + spine recording + Sources error surfacing —
// never a silent fail-open.
import type {
  CommandHookRunner,
  CommandHookResult,
  CommandHook,
} from '@copse/agent/hooks/command-executor.ts'
import type {
  AgentSessionInfo,
  HookContext,
  HookEventName,
  HookEventPayloads,
} from '@copse/agent/hooks/canonical-events.ts'
import type { BlockingHookOutcome, HookRunDecision } from '@copse/agent/hooks/hook-outcome.ts'
import { detectSandboxFailure } from './sandbox-failure-detection.ts'
import { hookRecursionGuardTripped } from './hook-depth.ts'
import { getDialectAdapter } from './dialect-registry.ts'
import { spawnHookProcess, type HookSpawnResult } from './hook-spawn.ts'
import { getSessionEnv } from './session-env.ts'
import type { DialectAdapter, DialectInterpretation } from './dialect-adapter.ts'

/** No usable response — the action proceeds (a command hook is never fail-hard). */
const ABSTAIN: CommandHookResult = { outcome: null, failed: false }

/**
 * Resolve a `failed` run to its outcome per the hook's `onFailure` (decision 9):
 * `closed` blocks (Cursor `failClosed: true`), `open` abstains (vendor default).
 */
function resolveFailure(
  hook: CommandHook,
  interpretation: DialectInterpretation,
): CommandHookResult {
  const outcome: BlockingHookOutcome | null =
    hook.onFailure === 'closed'
      ? {
          decision: 'deny',
          agentMessage:
            interpretation.runtimeError !== undefined
              ? `hook "${hook.id}" ${interpretation.runtimeError} — blocked by failClosed`
              : `hook "${hook.id}" failed — blocked by failClosed`,
        }
      : null
  return { outcome, failed: true, failureMode: hook.onFailure }
}

/**
 * Escalate a blocked-by-sandbox run to a failure (F3, decision 7). When a hook
 * ran inside the project sandbox and the runner-recorded signals say the OS
 * seatbelt blocked it (violations on a non-zero exit, or the wrapper failed to
 * start), the run is turned into a `failed` interpretation regardless of what
 * the hook printed — so the block routes through the hook's `onFailure`
 * (`closed` → deny; `open` → no-op but still recorded + surfaced) and never a
 * silent fail-open that hides it. Detection keys off runner-side signals only
 * (never the hook's own stdout — issue #104), and it is a no-op for an
 * unsandboxed run (Linux / Windows / `sandbox: false`), where nothing contained
 * the hook to begin with. A clean sandboxed run passes through untouched.
 */
export interface CommandHookRunInput {
  /** Dialect event name (e.g. `beforeShellExecution`). */
  event: string
  /** The hook's command string — its stable id in dialect configs. */
  hookId: string
  startedAt: number
  durationMs: number
  /** Process exit code; null when killed (timeout / output cap) or spawn failed. */
  exitCode: number | null
  /** Whether stdout parsed into a response (empty stdout = intentional no-response). */
  parseOk: boolean
  decision: HookRunDecision
  /** The exact JSON written to the hook's stdin, stored verbatim as a blob. */
  stdin: string
  /** Raw captured streams, stored verbatim as blobs. */
  stdout: string
  stderr: string
}

/**
 * Sink for one command-hook execution: the exact stdin bytes, raw stdout and
 * stderr, and the normalized decision. The host records these on the thread's
 * spine (decision 6); the runner only reports them.
 */
export type RecordCommandHookRun = (input: CommandHookRunInput) => void

export function applySandboxBlock(
  interpretation: DialectInterpretation,
  spawn: HookSpawnResult,
): DialectInterpretation {
  if (!spawn.sandboxed) return interpretation
  const detection = detectSandboxFailure({
    exitCode: spawn.exitCode,
    violationCount: spawn.sandboxViolationCount,
    spawnFailed: spawn.spawnError,
  })
  if (!detection.likely) return interpretation
  // Rebuild explicitly (rather than spreading) so any async follow-up /
  // session env the hook printed before seatbelt killed it is dropped — a
  // blocked hook produced no trustworthy response.
  return {
    outcome: null,
    failed: true,
    parseOk: false,
    spineEvent: interpretation.spineEvent,
    spineDecision: { ...interpretation.spineDecision, sandboxBlocked: true },
    runtimeError: `blocked by the project sandbox (${detection.reasons.join('; ')})`,
  }
}

/**
 * Spawn one hook, interpret it via its dialect, record the spine line, and
 * resolve failures per `onFailure` — the shared execution path every wired
 * event uses. Only the marshalled `request` and the dialect `interpret` closure
 * differ per event; a null request means the hook does not apply (abstain).
 */
async function spawnInterpretResolve(
  hook: CommandHook,
  adapter: DialectAdapter,
  request: unknown,
  interpret: (spawn: HookSpawnResult) => DialectInterpretation,
  context: HookContext,
  record: RecordCommandHookRun | undefined,
): Promise<CommandHookResult> {
  if (request === null) return ABSTAIN

  // H4: propagate this session's `sessionStart` env into the hook process. Keyed
  // by the session id (`conversation_id` = thread id) on the agent-session info;
  // the store is empty until a `sessionStart` hook has populated it, so this is a
  // no-op outside an env-propagating session.
  const sessionId = context.agentSession?.conversationId
  const sessionEnv = sessionId ? getSessionEnv(sessionId) : undefined

  const spawn = await spawnHookProcess(hook.command, request, {
    cwd: hook.cwd ?? process.cwd(),
    ...(hook.timeoutMs !== undefined ? { timeoutMs: hook.timeoutMs } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
    ...(sessionEnv ? { sessionEnv } : {}),
    // F3 (decision 7): sandboxed by default; the Copse `sandbox: false` escape is
    // the only opt-out (Cursor / Claude never set the field, so they default to
    // sandboxed too). macOS-only enforcement, a default not a guarantee.
    ...(hook.sandbox !== undefined ? { sandbox: hook.sandbox } : {}),
  })

  // A blocked-by-sandbox run is escalated to a failure BEFORE recording /
  // resolution (F3): the block is recorded on the spine + surfaced in Sources
  // and routed through `onFailure`, never a silent fail-open.
  const interpretation = applySandboxBlock(interpret(spawn), spawn)

  // Always-on spine recording (decision 6): one hook_run line per execution,
  // with the stdin payload plus raw stdout AND stderr as blobs, next to the
  // normalized decision — the whole exchange, inspectable later. The host hands
  // the runner a sink bound to the right attribution (a detached async fire site
  // binds a snapshot captured before `endHookRunRecording`; blocking hooks bind
  // the live context), so the runner never sees recording state.
  record?.({
    event: interpretation.spineEvent,
    hookId: hook.id,
    startedAt: spawn.startedAt,
    durationMs: spawn.durationMs,
    exitCode: spawn.exitCode,
    parseOk: interpretation.parseOk,
    decision: interpretation.spineDecision,
    stdin: spawn.stdin,
    stdout: spawn.stdout,
    stderr: spawn.stderr,
  })

  if (interpretation.failed) {
    if (interpretation.runtimeError !== undefined) {
      adapter.recordRuntimeFailure(interpretation.spineEvent, hook.id, interpretation.runtimeError)
    }
    return resolveFailure(hook, interpretation)
  }

  return {
    outcome: interpretation.outcome,
    failed: false,
    // Async follow-up (D1 subagentStop) rides through to the queue channel via
    // emitAsync's `onAsyncOutcome`; absent on every blocking-event run.
    ...(interpretation.queueMessage ? { queueMessage: interpretation.queueMessage } : {}),
    // Session env (H4 sessionStart): forwarded to `onAsyncOutcome` by emitAsync
    // and collected into the session env store; absent on every other run.
    ...(interpretation.sessionEnv ? { sessionEnv: interpretation.sessionEnv } : {}),
  }
}

/**
 * What one event's dialect wiring produced: the marshalled stdin request and
 * the closure that applies the dialect's exit-code table to the spawn.
 */
interface DispatchPlan {
  request: unknown
  interpret: (spawn: HookSpawnResult) => DialectInterpretation
}

/**
 * Wire one canonical event to its dialect methods. `E` ties the hook and the
 * payload together, which is the whole point of the table below.
 */
type EventDispatch<E extends HookEventName> = (
  hook: CommandHook<E>,
  payload: HookEventPayloads[E],
  adapter: DialectAdapter,
  session: AgentSessionInfo | undefined,
) => DispatchPlan | null

/**
 * The common shape: a dialect either declares both halves of an event's pair or
 * neither, and the interpret closure only needs the payload. A dialect that
 * omits the pair (Claude has no compose-path hook; the foreign adapters declare
 * none of the F2 Copse-native events) yields null and the runner abstains.
 */
function pairedDispatch<E extends HookEventName>(
  hook: CommandHook<E>,
  payload: HookEventPayloads[E],
  session: AgentSessionInfo | undefined,
  marshal:
    | ((hook: CommandHook, payload: HookEventPayloads[E], session?: AgentSessionInfo) => unknown)
    | undefined,
  interpret:
    | ((spawn: HookSpawnResult, payload: HookEventPayloads[E]) => DialectInterpretation)
    | undefined,
): DispatchPlan | null {
  if (!marshal || !interpret) return null
  return {
    request: marshal(hook, payload, session),
    interpret: (spawn) => interpret(spawn, payload),
  }
}

/**
 * Per-event dialect wiring, keyed by canonical event name.
 *
 * This table is why the runner has no payload type predicates. `run` receives
 * `hook: CommandHook<E>` and `payload: HookEventPayloads[E]` as two separate
 * parameters, so gating on `hook.event` narrows the hook and leaves the payload
 * at its unresolved indexed-access type — TypeScript has no way to carry the
 * correlation across two parameters. The twelve predicates that used to live
 * here existed only to restate it, and because they had nothing but key
 * presence to go on, siblings collided: `stop` had to say
 * `!('subagentType' in payload)` to avoid matching `subagentStop`. Those
 * negative clauses were load-bearing, invisible in the types, and unchecked —
 * a predicate asserts `payload is T` and the compiler takes its word.
 *
 * Indexing this table with `hook.event` keeps both sides on the same `E`, so
 * the compiler resolves the pair itself. It is strictly stronger than the
 * predicates were: an entry that reads a field its payload lacks, reaches for a
 * sibling event's field, or names an event outside the union is a type error
 * (execution guidance rule 3 — prefer a compile error over a runtime check).
 *
 * An event with no entry has no fire site wired yet and abstains, which is the
 * same no-op the unwired branch always produced.
 */
const EVENT_DISPATCH: { [E in HookEventName]?: EventDispatch<E> } = {
  // The permission gate (A2). Its pair is the one a dialect must declare, and
  // `interpretToolGate` also takes the hook so a dialect whose events fan out
  // over the one canonical gate can recover which wire event ran.
  toolGate: (hook, payload, adapter, session) => ({
    request: adapter.marshalToolGateRequest(hook, payload, session),
    interpret: (spawn) => adapter.interpretToolGate(spawn, payload, hook),
  }),
  beforeSubmitPrompt: (hook, payload, adapter, session) =>
    pairedDispatch(
      hook,
      payload,
      session,
      adapter.marshalBeforeSubmitPromptRequest?.bind(adapter),
      adapter.interpretBeforeSubmitPrompt?.bind(adapter),
    ),
  afterFileEdit: (hook, payload, adapter, session) =>
    pairedDispatch(
      hook,
      payload,
      session,
      adapter.marshalAfterFileEditRequest?.bind(adapter),
      adapter.interpretAfterFileEdit?.bind(adapter),
    ),
  stop: (hook, payload, adapter, session) =>
    pairedDispatch(
      hook,
      payload,
      session,
      adapter.marshalStopRequest?.bind(adapter),
      adapter.interpretStop?.bind(adapter),
    ),
  subagentStart: (hook, payload, adapter, session) =>
    pairedDispatch(
      hook,
      payload,
      session,
      adapter.marshalSubagentStartRequest?.bind(adapter),
      adapter.interpretSubagentStart?.bind(adapter),
    ),
  subagentStop: (hook, payload, adapter, session) =>
    pairedDispatch(
      hook,
      payload,
      session,
      adapter.marshalSubagentStopRequest?.bind(adapter),
      adapter.interpretSubagentStop?.bind(adapter),
    ),
  // Like `toolGate`, the post-tool interpretation takes the hook to resolve
  // Cursor's dedicated vs generic post-tool flavors.
  afterToolUse: (hook, payload, adapter, session) => {
    const marshal = adapter.marshalAfterToolUseRequest?.bind(adapter)
    const interpret = adapter.interpretAfterToolUse?.bind(adapter)
    if (!marshal || !interpret) return null
    return {
      request: marshal(hook, payload, session),
      interpret: (spawn) => interpret(spawn, payload, hook),
    }
  },
  sessionStart: (hook, payload, adapter, session) =>
    pairedDispatch(
      hook,
      payload,
      session,
      adapter.marshalSessionStartRequest?.bind(adapter),
      adapter.interpretSessionStart?.bind(adapter),
    ),
  beforeDiffApply: (hook, payload, adapter, session) =>
    pairedDispatch(
      hook,
      payload,
      session,
      adapter.marshalBeforeDiffApplyRequest?.bind(adapter),
      adapter.interpretBeforeDiffApply?.bind(adapter),
    ),
  afterDiffApply: (hook, payload, adapter, session) =>
    pairedDispatch(
      hook,
      payload,
      session,
      adapter.marshalAfterDiffApplyRequest?.bind(adapter),
      adapter.interpretAfterDiffApply?.bind(adapter),
    ),
  permissionDecision: (hook, payload, adapter, session) =>
    pairedDispatch(
      hook,
      payload,
      session,
      adapter.marshalPermissionDecisionRequest?.bind(adapter),
      adapter.interpretPermissionDecision?.bind(adapter),
    ),
  postTurnReview: (hook, payload, adapter, session) =>
    pairedDispatch(
      hook,
      payload,
      session,
      adapter.marshalPostTurnReviewRequest?.bind(adapter),
      adapter.interpretPostTurnReview?.bind(adapter),
    ),
}

/**
 * Build the host command-hook runner injected into `HookContext.runCommandHook`.
 * A2 wired the `toolGate` event (the permission gate); B1 adds
 * `beforeSubmitPrompt` (the compose path); B2 adds `afterFileEdit` (the
 * diff-queue / write-tool site); B3 adds `stop` (turn end / abort, dispatched
 * detached — decision 3); D1 adds `subagentStart` (blocking spawn gate, matcher
 * on subagent type) and `subagentStop` (detached completion, `followup_message`
 * routed to the queue channel); D2 adds `afterToolUse` (post-tool observation,
 * dispatched detached — Cursor's dedicated and generic post-tool flavors with
 * a capped output snapshot). F2 adds the four Copse-native events —
 * `beforeDiffApply` (blocking diff-apply gate), `afterDiffApply` /
 * `permissionDecision` / `postTurnReview` (detached observations). Foreign
 * adapters (Cursor / Claude) declare no marshaller for those, so the runner
 * abstains for them. Other canonical events land their fire sites in later
 * phases and register no command hooks yet, so they abstain.
 */
export function createCommandHookRunner(opts?: {
  /**
   * Where each command-hook execution is reported. The host binds this to its
   * spine recorder with the right attribution: a detached fire site (`stop`,
   * `subagentStop`, …) binds a context snapshot captured synchronously so the
   * line survives the run ending (decision 3/6); a blocking hook binds the live
   * context. Omit to run without recording.
   */
  record?: RecordCommandHookRun
}): CommandHookRunner {
  const record = opts?.record
  return {
    async run<E extends HookEventName>(
      hook: CommandHook<E>,
      payload: HookEventPayloads[E],
      context: HookContext,
    ): Promise<CommandHookResult> {
      // Recursion guard (decision 5): if this Copse is itself running inside a
      // hook (`COPSE_HOOK_DEPTH` ≥ MAX), suppress all command-hook spawns so a
      // hook that re-enters Copse cannot drive an unbounded hook→Copse→hook
      // loop. Abstaining (never fail-hard) matches a command hook that returns
      // no decision — the action proceeds, one nested level breaks the loop.
      if (hookRecursionGuardTripped()) return ABSTAIN

      // Every wired agent-session event stamps the real conversation / generation
      // ids + running model onto its wire payload (B4); the host captures it at
      // the fire site and hands it through the context (opaque to packages/agent).
      const session = context.agentSession

      const dispatch = EVENT_DISPATCH[hook.event]
      // No entry: the event's fire site lands in a later phase. Abstain
      // cleanly rather than failing — same no-op as before the table.
      if (!dispatch) return ABSTAIN
      const adapter = getDialectAdapter(hook.dialect)
      if (!adapter) return ABSTAIN
      const plan = dispatch(hook, payload, adapter, session)
      // This dialect declares no marshaller for the event.
      if (!plan) return ABSTAIN
      return spawnInterpretResolve(hook, adapter, plan.request, plan.interpret, context, record)
    },
  }
}
