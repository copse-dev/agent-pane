// Halt-run semantics (H3) — routing a hook's `haltRun` (`continue: false`)
// through the run's real abort path, attributed to the hook, spine-recorded.
//
// Two decisions converge here:
//   - **decision 12** — `haltRun` is allowed from async hooks and routes through
//     the *existing* abort path (the run's `AbortController`), attributed to the
//     hook. It is a programmatic stop button; the agent loop already handles that
//     external signal, so H3 does not invent a new stop mechanism — it points the
//     hook's halt at the same `controller.abort()` the Stop button uses.
//   - **decision 16** — an async hook output is epoch-scoped to its emitting turn
//     tree. A late `haltRun` from a *completed* turn must never abort a newer,
//     unrelated human turn, so a **stale-epoch `haltRun` is a suppressed no-op**,
//     recorded in the spine as suppressed. Only a halt whose epoch matches the
//     currently-active run may abort.
//
// Module layout (execution-guidance rule 4): the abort path + active-run ledger
// are host concerns (they own the `AbortController`), so this lives in
// `src/main/services/hooks/`. `packages/agent` stays Electron-free; it only
// *carries* the epoch on every async dispatch (C1) — the staleness comparison
// and the abort happen here.
import type { AsyncOutcomeRecord } from '@copse/agent/hooks/hook-registry.ts'
import type { TurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import { recordHaltRun } from '../hook-run-recorder.ts'

/** What happened to a `haltRun` request. */
export type HaltDisposition =
  /** The active turn tree was aborted (decision 12). */
  | 'halted'
  /** A stale-epoch async halt was a suppressed no-op (decision 16). */
  | 'suppressed-stale'

/**
 * The abort handle the run registers for its thread. Called with the hook's
 * reason so the run can surface it as the terminal `done` chunk's `stopReason`
 * (the existing user-visible channel; the dedicated card is G1). Aborting is
 * idempotent — a second call after the run already tore down is harmless.
 */
export type HaltAbort = (reason: string) => void

interface HaltTarget {
  /** Epoch of the run currently active on this thread (decision 16 reference). */
  turnTreeId: TurnTreeId
  abort: HaltAbort
}

/**
 * Threads with an abortable run in flight, keyed by thread id. The run
 * registers on start and clears on end, so at most one target exists per thread
 * — the *current* turn tree. A halt whose epoch does not match the registered
 * target (or arrives with no target at all) is stale by construction.
 */
const targets = new Map<string, HaltTarget>()

/**
 * Register the currently-active run as the abort target for its thread (H3).
 * Called at run start alongside `abortMap.set` in agent-service; the epoch is
 * the run's turn-tree id (decision 16), the reference every incoming halt is
 * checked against.
 */
export function registerHaltTarget(
  threadId: string,
  turnTreeId: TurnTreeId,
  abort: HaltAbort,
): void {
  targets.set(threadId, { turnTreeId, abort })
}

/**
 * Clear the abort target for a thread, but only when it still belongs to the
 * given epoch — so a stale clear from a finished run cannot unregister a newer
 * run that already reclaimed the thread (mirrors `clearActiveRunThread`).
 */
export function clearHaltTarget(threadId: string, turnTreeId: TurnTreeId): void {
  if (targets.get(threadId)?.turnTreeId === turnTreeId) targets.delete(threadId)
}

/** The recorder used for halt effect lines; overridable in tests. */
let recorder: typeof recordHaltRun = recordHaltRun

/** Swap the spine recorder (contract tests). Pass `null` to restore the default. */
export function setHaltRunRecorderForTesting(fn: typeof recordHaltRun | null): void {
  recorder = fn ?? recordHaltRun
}

interface HaltAttribution {
  event: string
  hookId: string
  executor: 'function' | 'command'
  reason: string
}

/**
 * Route an **async** hook's `haltRun` through the abort path with the decision-16
 * staleness check. The record carries its emitting epoch (C1); a halt is applied
 * only when that epoch matches the run currently active on the thread. A halt
 * from a stale epoch — or one that arrives when no run is active — is a
 * suppressed no-op, recorded as suppressed. Either way the effect is
 * spine-recorded, so a late async stop is never silent.
 */
export function requestAsyncHaltRun(record: AsyncOutcomeRecord, threadId: string): HaltDisposition {
  const halt = record.outcome.haltRun
  if (!halt) return 'suppressed-stale'
  const target = targets.get(threadId)
  const current = target !== undefined && target.turnTreeId === record.turnTreeId
  return applyOrSuppress(current ? target : null, {
    event: record.event,
    hookId: record.hookId,
    executor: 'function',
    reason: halt.reason,
  })
}

/**
 * Route a **blocking** hook's `haltRun` (e.g. a `toolGate` hook returning
 * `continue: false` mid-turn) through the abort path. A blocking hook fires
 * synchronously inside the active run, so it is current by construction — there
 * is no epoch to be stale against — and always aborts when a run is active.
 * Consistent with the async path (decision 12: same abort path, attributed to
 * the hook). A no-op when no run is active (nothing to abort).
 */
export function haltRunFromBlockingHook(input: {
  threadId: string
  event: string
  hookId: string
  reason: string
}): HaltDisposition {
  const target = targets.get(input.threadId) ?? null
  return applyOrSuppress(target, {
    event: input.event,
    hookId: input.hookId,
    executor: 'command',
    reason: input.reason,
  })
}

/** Shared tail: abort the target when present, spine-record the effect either way. */
function applyOrSuppress(target: HaltTarget | null, attribution: HaltAttribution): HaltDisposition {
  const applied = target !== null
  recorder({
    event: attribution.event,
    hookId: attribution.hookId,
    executor: attribution.executor,
    applied,
    reason: attribution.reason,
  })
  if (target) {
    target.abort(attribution.reason)
    return 'halted'
  }
  return 'suppressed-stale'
}
