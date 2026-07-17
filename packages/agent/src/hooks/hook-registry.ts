// The unified hook registry — Milestone 0.1: function executor only.
//
// One registry, one event vocabulary (decision 1). M0.1 ships the in-process
// *function* executor for blocking assembly events; the command executor, dialect
// adapters, async detached dispatch, queue/budget/epoch, and spine recording all
// plug into this same seam in later phases. The proof that the seam is extensible
// is that registering an additional hook — here or in a test — needs no change to
// any loop code (M0 acceptance).
//
// This module lives in `packages/agent` and imports nothing from the host app
// (execution-guidance rule 4).
import { errorMessage } from '../internal-utils.ts'
import type {
  AsyncHookOutcome,
  BlockingHookOutcome,
  HookDecision,
  HookHaltRun,
} from './hook-outcome.ts'
import type {
  AsyncHook,
  BlockingHook,
  FunctionHookContext,
  HookContext,
  HookEventName,
  HookEventPayloads,
  HookRunRecord,
} from './canonical-events.ts'
import type { CommandHook, CommandHookResult } from './command-executor.ts'
import type { AsyncDispatcher, AsyncDispatchDisposition } from './async-dispatcher.ts'
import type { TurnTreeId } from './turn-tree.ts'

/**
 * Feed one execution to the host's spine-recording sink (decision 6).
 * Recording is observability, never behavior: a throwing sink is swallowed so
 * it cannot abort an emit or masquerade as a hook failure.
 */
function recordRun(context: HookContext, record: HookRunRecord): void {
  if (!context.recordHookRun) return
  try {
    context.recordHookRun(record)
  } catch (err) {
    console.warn(`[hooks] recordHookRun sink threw for "${record.hookId}":`, err)
  }
}
import { TURN_START_HOOKS } from './turn-start-hooks.ts'
import { BEFORE_FINALIZE_HOOKS } from './before-finalize-hooks.ts'

/** One hook's contribution to a fired event, tagged with its author. */
export interface HookOutcomeRecord {
  hookId: string
  outcome: BlockingHookOutcome
}

/** The result of firing a blocking canonical event. */
export interface HookEmitResult {
  /**
   * Per-hook outcomes in registration order. Hooks that returned `void` (no
   * opinion) are omitted, so an event with zero registered hooks — or hooks that
   * all abstain — yields an empty list and the harness applies nothing.
   */
  outcomes: readonly HookOutcomeRecord[]
}

/**
 * One async hook's outcome, tagged with its author and the emitting epoch
 * (decision 16). The detached executor is fire-and-forget, so an async outcome
 * cannot influence the current action; it is reported to a host callback for the
 * pending-message-queue channel (C2). C1 carries the `turnTreeId` on the record
 * so C2 can check staleness — C1 wires no queue itself.
 */
export interface AsyncOutcomeRecord {
  event: HookEventName
  hookId: string
  /** Emitting turn-tree epoch this outcome belongs to (decision 16). */
  turnTreeId: TurnTreeId
  outcome: AsyncHookOutcome
}

/**
 * Cross-cutting context for firing a *detached async* event ({@link
 * HookRegistry.emitAsync}). Extends the function-hook context with the three
 * things the detached executor needs: the shared {@link AsyncDispatcher} that
 * owns the per-thread concurrency cap + FIFO (decision 13), the owning thread,
 * and the emitting {@link TurnTreeId} carried on every dispatch (decision 16).
 * An optional `onAsyncOutcome` sink collects outcomes for the C2 queue channel.
 *
 * The `signal` inherited from {@link HookContext} is **not** forwarded to the
 * dispatched hooks: decision 3 says an already-dispatched hook runs to its own
 * completion even after abort, so the detached run context strips it — abort
 * halts *emission* here, never in-flight work.
 */
export interface AsyncEmitContext extends FunctionHookContext {
  /** Shared detached executor (per-thread cap + FIFO). */
  dispatcher: AsyncDispatcher
  /** Thread the concurrency cap + FIFO are scoped to. */
  threadId: string
  /** Emitting turn-tree epoch, carried on every dispatch (decision 16). */
  turnTreeId: TurnTreeId
  /** Collects async outcomes for the C2 pending-message-queue channel (stub in C1). */
  onAsyncOutcome?: (record: AsyncOutcomeRecord) => void
}

/**
 * The synchronous accounting {@link HookRegistry.emitAsync} returns: how many
 * hooks were dispatched now, deferred into the FIFO, or dropped over the pending
 * cap. Returned synchronously *by design* — the caller learns the dispatch
 * disposition without ever awaiting a hook's completion (decision 3).
 */
export interface AsyncEmitResult {
  /** Dispatched immediately (under the concurrency cap). */
  running: number
  /** Deferred into the pending-dispatch FIFO (over cap, still detached). */
  pending: number
  /** Dropped because the pending FIFO was full (recorded via the drop sink). */
  dropped: number
}

/**
 * Thrown when a first-party function hook throws. Fail-hard (decision 9): the
 * error is a bug in first-party code and must surface, never be swallowed into a
 * fail-open `allow`. The original error is preserved as `cause`.
 */
export class HookExecutionError extends Error {
  readonly hookId: string
  readonly event: HookEventName

  constructor(hookId: string, event: HookEventName, cause: unknown) {
    super(`hook "${hookId}" threw while handling "${event}": ${errorMessage(cause)}`, { cause })
    this.name = 'HookExecutionError'
    this.hookId = hookId
    this.event = event
  }
}

export class HookRegistry {
  // Keyed by event; `BlockingHook`'s method-syntax `run` makes hooks for
  // different events co-storable here without a cast (see canonical-events.ts).
  private readonly blockingHooks = new Map<HookEventName, BlockingHook[]>()
  // Command (spawned-process) hooks share the registry (decision 1) but run via
  // the host-injected runner, not in-process, so they live in their own map.
  private readonly commandHooks = new Map<HookEventName, CommandHook[]>()
  // First-party *async* (detached) function hooks — dispatched through the
  // detached executor (C1), never awaited (decision 3). Separate map because
  // their outcome type is separate (decisions 4 & 11).
  private readonly asyncHooks = new Map<HookEventName, AsyncHook[]>()

  /** Register a first-party blocking function hook. Later registrations run later. */
  register<E extends HookEventName>(hook: BlockingHook<E>): void {
    const list = this.blockingHooks.get(hook.event)
    if (list) list.push(hook)
    else this.blockingHooks.set(hook.event, [hook])
  }

  /**
   * Register a first-party *async* (detached) function hook (C1). Dispatched via
   * {@link emitAsync} through the shared executor, never awaited. Later
   * registrations dispatch later (order within an event is not a promise — the
   * FIFO has "no ordering promises", decision 13).
   */
  registerAsync<E extends HookEventName>(hook: AsyncHook<E>): void {
    const list = this.asyncHooks.get(hook.event)
    if (list) list.push(hook)
    else this.asyncHooks.set(hook.event, [hook])
  }

  /**
   * Register a command (spawned-process) hook — same registry, same events
   * (decision 1). Dispatched via {@link HookContext.runCommandHook}; failure is
   * resolved per-dialect by the runner (decision 9), never fail-hard.
   */
  registerCommand<E extends HookEventName>(hook: CommandHook<E>): void {
    const list = this.commandHooks.get(hook.event)
    if (list) list.push(hook)
    else this.commandHooks.set(hook.event, [hook])
  }

  /** Function hooks registered for `event`, in registration order (empty when none). */
  hooksFor(event: HookEventName): readonly BlockingHook[] {
    return this.blockingHooks.get(event) ?? []
  }

  /** Command hooks registered for `event`, in registration order (empty when none). */
  commandHooksFor(event: HookEventName): readonly CommandHook[] {
    return this.commandHooks.get(event) ?? []
  }

  /** Async function hooks registered for `event`, in registration order (empty when none). */
  asyncHooksFor(event: HookEventName): readonly AsyncHook[] {
    return this.asyncHooks.get(event) ?? []
  }

  /**
   * Fire a blocking canonical event: run every registered function hook, then
   * every registered command hook, in registration order, and collect the
   * outcomes they return. With zero registered hooks this resolves to an empty
   * result and the caller applies nothing — the "emitting changes nothing"
   * guarantee M0 shipped, preserved here.
   *
   * Two executor kinds, two failure policies (decisions 1 & 9):
   *   - Function hooks **fail hard**: a throw aborts the emit with a
   *     {@link HookExecutionError}, never downgraded to an allow.
   *   - Command hooks **defer failure to their dialect**: the runner resolves
   *     crash / timeout / invalid JSON per the hook's `onFailure` before
   *     returning, so a command failure is a normalized outcome (or none), never
   *     a thrown emit. A runner that itself throws is caught and resolved the
   *     same way, so one buggy command hook can never fail-hard the harness.
   */
  async emit<E extends HookEventName>(
    event: E,
    payload: HookEventPayloads[E],
    context: FunctionHookContext,
  ): Promise<HookEmitResult> {
    const outcomes: HookOutcomeRecord[] = []
    await this.dispatchFunctionHooks(event, payload, context, outcomes)
    await this.dispatchCommandHooks(event, payload, context, outcomes)
    return { outcomes }
  }

  /** Run the in-process function hooks for an event (fail-hard, decision 9). */
  private async dispatchFunctionHooks<E extends HookEventName>(
    event: E,
    payload: HookEventPayloads[E],
    context: FunctionHookContext,
    outcomes: HookOutcomeRecord[],
  ): Promise<void> {
    const hooks = this.blockingHooks.get(event)
    if (!hooks || hooks.length === 0) return
    for (const hook of hooks) {
      if (context.signal?.aborted) break
      let outcome: BlockingHookOutcome | undefined
      const startedAt = Date.now()
      try {
        // A specific `HookEventPayloads[E]` is assignable to `run`'s union
        // parameter, so no cast is needed to dispatch the stored hook.
        outcome = await hook.run(payload, context)
      } catch (cause) {
        // Record the failed execution first (decision 6: *every* execution is
        // recorded), then fail hard as before — the throw is never swallowed.
        recordRun(context, {
          event,
          hookId: hook.id,
          startedAt,
          durationMs: Date.now() - startedAt,
          outcome: null,
          error: errorMessage(cause),
        })
        throw new HookExecutionError(hook.id, event, cause)
      }
      recordRun(context, {
        event,
        hookId: hook.id,
        startedAt,
        durationMs: Date.now() - startedAt,
        outcome: outcome ?? null,
      })
      if (outcome) outcomes.push({ hookId: hook.id, outcome })
    }
  }

  /**
   * Run the command hooks for an event via the host-injected runner. Never
   * fail-hard (decision 9): the runner resolves dialect failure semantics, and
   * a runner that throws is caught and resolved with the hook's own `onFailure`.
   * Command spine recording is owned by the runner (it holds the process's
   * stdout/stderr/exit code), so this path does not touch `recordHookRun`.
   * With no runner injected, command hooks are skipped — never a hard failure.
   */
  private async dispatchCommandHooks<E extends HookEventName>(
    event: E,
    payload: HookEventPayloads[E],
    context: FunctionHookContext,
    outcomes: HookOutcomeRecord[],
  ): Promise<void> {
    const hooks = this.commandHooks.get(event)
    if (!hooks || hooks.length === 0) return
    const runner = context.runCommandHook
    if (!runner) return
    for (const hook of hooks) {
      if (context.signal?.aborted) break
      let result: CommandHookResult
      try {
        result = await runner.run(hook, payload, context)
      } catch (cause) {
        result = commandRunnerCrashResult(hook, cause)
      }
      if (result.outcome) outcomes.push({ hookId: hook.id, outcome: result.outcome })
    }
  }

  /**
   * Fire a *detached async* canonical event (C1; decisions 3, 13, 16). Every
   * registered async function hook and every registered command hook for the
   * event is handed to the shared {@link AsyncDispatcher}, which spawns it under
   * the per-thread concurrency cap or defers it into the pending FIFO — **and
   * this method never awaits any of them.** It returns synchronously with the
   * dispatch accounting, so the caller (`void registry.emitAsync(...)`) learns
   * how work was scheduled without blocking on a single hook (decision 3, "no
   * drain barrier").
   *
   * Every dispatch carries the emitting {@link TurnTreeId} (decision 16) so a
   * late output can be checked for staleness in C2/C3. Abort stops *emission* —
   * the harness stops calling this — but a hook already dispatched runs to its
   * own completion: the run context strips the abort signal (see
   * {@link detachedHookContext}) so an in-flight process is never killed.
   *
   * Async outcomes (from function hooks) are reported to `onAsyncOutcome` for the
   * C2 queue channel; C1 wires no queue. Command hooks for async observation
   * events (`stop`) are notification-only, so their blocking outcome is ignored
   * here (they record their own spine line via the runner).
   */
  emitAsync<E extends HookEventName>(
    event: E,
    payload: HookEventPayloads[E],
    context: AsyncEmitContext,
  ): AsyncEmitResult {
    const { dispatcher, threadId, turnTreeId, onAsyncOutcome } = context
    const hookContext = detachedHookContext(context)
    const summary: AsyncEmitResult = { running: 0, pending: 0, dropped: 0 }

    const tally = (disposition: AsyncDispatchDisposition): void => {
      if (disposition === 'running') summary.running += 1
      else if (disposition === 'pending') summary.pending += 1
      else summary.dropped += 1
    }

    for (const hook of this.asyncHooks.get(event) ?? []) {
      tally(
        dispatcher.dispatch({
          event,
          hookId: hook.id,
          executor: 'function',
          threadId,
          turnTreeId,
          run: async () => {
            const outcome = await hook.run(payload, hookContext)
            if (outcome && onAsyncOutcome) {
              onAsyncOutcome({ event, hookId: hook.id, turnTreeId, outcome })
            }
          },
        }),
      )
    }

    const runner = hookContext.runCommandHook
    if (runner) {
      for (const hook of this.commandHooks.get(event) ?? []) {
        tally(
          dispatcher.dispatch({
            event,
            hookId: hook.id,
            executor: 'command',
            threadId,
            turnTreeId,
            run: async () => {
              // The runner records its own spine line and resolves dialect
              // failure; async observation events return no actionable decision
              // off the critical path, so the result is intentionally dropped.
              // A future async command output channel (queueMessage) routes
              // through C2, not here.
              await runner.run(hook, payload, hookContext)
            },
          }),
        )
      }
    }

    return summary
  }
}

/**
 * Build the context a *detached* hook runs with: the base function-hook context
 * minus the emit-only fields (dispatcher / thread / epoch / outcome sink) and —
 * critically — minus the abort `signal`. Decision 3: an already-dispatched hook
 * runs to its own completion even after abort, so forwarding the signal (which a
 * command runner would wire into its process spawn) would let abort *kill*
 * in-flight work — exactly the drain/kill barrier the detached executor must not
 * have. Fields are copied only when present to stay clean under
 * `exactOptionalPropertyTypes`.
 */
function detachedHookContext(context: AsyncEmitContext): FunctionHookContext {
  const detached: FunctionHookContext = {}
  if (context.resolveGithubRepoSlug) detached.resolveGithubRepoSlug = context.resolveGithubRepoSlug
  if (context.recordHookRun) detached.recordHookRun = context.recordHookRun
  if (context.runCommandHook) detached.runCommandHook = context.runCommandHook
  if (context.agentSession) detached.agentSession = context.agentSession
  if (context.emitChunk) detached.emitChunk = context.emitChunk
  if (context.loopState) detached.loopState = context.loopState
  return detached
}

/**
 * Resolve a command hook whose *runner* threw unexpectedly (a host bug, not the
 * script's own crash — that the runner resolves internally). Applies the hook's
 * per-dialect `onFailure` (decision 9): `closed` denies the gated action;
 * `open` yields no opinion, so the action proceeds. Never rethrows — command
 * hooks are not fail-hard.
 */
function commandRunnerCrashResult(hook: CommandHook, cause: unknown): CommandHookResult {
  const outcome: BlockingHookOutcome | null =
    hook.onFailure === 'closed'
      ? {
          decision: 'deny',
          agentMessage: `command hook "${hook.id}" failed: ${errorMessage(cause)}`,
        }
      : null
  return { outcome, failed: true, failureMode: hook.onFailure }
}

const DECISION_RANK: Record<HookDecision, number> = { allow: 0, ask: 1, deny: 2 }

function strongerDecision(current: HookDecision | undefined, next: HookDecision): HookDecision {
  if (current === undefined) return next
  return DECISION_RANK[next] > DECISION_RANK[current] ? next : current
}

/**
 * Combine per-hook outcomes into the single outcome the harness applies. This is
 * the registry's neutral combiner: injected context concatenates, and the
 * strongest signal wins where hooks disagree (first `haltRun`, most-restrictive
 * `decision`). Phase-specific semantics layer on top when their events are wired
 * — H1's sequential `updatedInput` pipeline re-runs policy analysis, B4 owns
 * deny/ask messaging — but M0.1's assembly events only ever set `injectContext`,
 * for which plain concatenation is exactly right.
 */
export function mergeBlockingOutcomes(records: readonly HookOutcomeRecord[]): BlockingHookOutcome {
  let haltRun: HookHaltRun | undefined
  let decision: HookDecision | undefined
  let updatedInput: Record<string, unknown> | undefined
  const injectChunks: string[] = []
  const agentChunks: string[] = []
  const userChunks: string[] = []

  for (const { outcome } of records) {
    // First halt wins: continuations are granted first-come in completion order
    // (decision 5), and a halt outranks everything (decision 12).
    if (haltRun === undefined && outcome.haltRun !== undefined) haltRun = outcome.haltRun
    if (outcome.decision !== undefined) decision = strongerDecision(decision, outcome.decision)
    if (outcome.updatedInput !== undefined) {
      updatedInput = { ...(updatedInput ?? {}), ...outcome.updatedInput }
    }
    if (outcome.injectContext) injectChunks.push(outcome.injectContext)
    if (outcome.agentMessage) agentChunks.push(outcome.agentMessage)
    if (outcome.userMessage) userChunks.push(outcome.userMessage)
  }

  // Assign only defined values so the result stays clean under
  // `exactOptionalPropertyTypes` (no explicit `undefined` fields).
  const merged: BlockingHookOutcome = {}
  if (haltRun !== undefined) merged.haltRun = haltRun
  if (decision !== undefined) merged.decision = decision
  if (updatedInput !== undefined) merged.updatedInput = updatedInput
  if (injectChunks.length > 0) merged.injectContext = injectChunks.join('\n\n')
  if (agentChunks.length > 0) merged.agentMessage = agentChunks.join('\n\n')
  if (userChunks.length > 0) merged.userMessage = userChunks.join('\n\n')
  return merged
}

/**
 * First-party hooks registered on every fresh registry. M0.2 fills in the
 * turn-start steering / pin hooks; M0.3 adds the finalize closeout nudge hook.
 * Registration order within each event is load-bearing (assembly / attempt
 * mapping); cross-event order is not.
 */
export const FIRST_PARTY_HOOKS: readonly BlockingHook[] = [
  ...TURN_START_HOOKS,
  ...BEFORE_FINALIZE_HOOKS,
]

/** Build a registry pre-loaded with the static first-party hook list. */
export function createHookRegistry(
  hooks: readonly BlockingHook[] = FIRST_PARTY_HOOKS,
): HookRegistry {
  const registry = new HookRegistry()
  for (const hook of hooks) registry.register(hook)
  return registry
}
