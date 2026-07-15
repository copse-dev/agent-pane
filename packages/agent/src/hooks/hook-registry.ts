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
import type { BlockingHookOutcome, HookDecision, HookHaltRun } from './hook-outcome.ts'
import type {
  BlockingHook,
  HookContext,
  HookEventName,
  HookEventPayloads,
} from './canonical-events.ts'
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

  /** Register a first-party blocking hook. Later registrations run later. */
  register<E extends HookEventName>(hook: BlockingHook<E>): void {
    const list = this.blockingHooks.get(hook.event)
    if (list) list.push(hook)
    else this.blockingHooks.set(hook.event, [hook])
  }

  /** Hooks registered for `event`, in registration order (empty when none). */
  hooksFor(event: HookEventName): readonly BlockingHook[] {
    return this.blockingHooks.get(event) ?? []
  }

  /**
   * Fire a blocking canonical event: run every registered hook in registration
   * order and collect the outcomes they return. With zero registered hooks this
   * resolves to an empty result and the caller applies nothing — the "emitting
   * changes nothing" guarantee this milestone ships.
   *
   * Fail-hard (decision 9): a hook that throws aborts the emit with a
   * {@link HookExecutionError}; the failure is never downgraded to an allow.
   */
  async emit<E extends HookEventName>(
    event: E,
    payload: HookEventPayloads[E],
    context: HookContext,
  ): Promise<HookEmitResult> {
    const hooks = this.blockingHooks.get(event)
    if (!hooks || hooks.length === 0) return { outcomes: [] }

    const outcomes: HookOutcomeRecord[] = []
    for (const hook of hooks) {
      if (context.signal?.aborted) break
      let outcome: BlockingHookOutcome | undefined
      try {
        // A specific `HookEventPayloads[E]` is assignable to `run`'s union
        // parameter, so no cast is needed to dispatch the stored hook.
        outcome = await hook.run(payload, context)
      } catch (cause) {
        throw new HookExecutionError(hook.id, event, cause)
      }
      if (outcome) outcomes.push({ hookId: hook.id, outcome })
    }
    return { outcomes }
  }
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
