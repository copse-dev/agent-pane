// Unified auto-continuation budget — Decision 5 of the hooks platform.
//
// A single counter per **turn tree** (everything descending from one
// human-originated submission). The ledger counts **machine-initiated new model
// turns** only: hook send-now, `stop`/`subagentStop` follow-ups, post-turn
// remediation cycles, pre-review todo attempts, and todo-closeout turns.
// **In-loop nudges do not count** (truncation-continue, finalize, loop, and
// reasoning-runaway nudges are mid-turn message pushes inside one `runAgentLoop`
// invocation, already bounded by `maxSteps` / `DEFAULT_MAX_LLM_CALLS` and the run
// deadline — known implementation trap: "in-loop nudges are not continuations").
//
// Hard cap default 5; the existing per-mechanism caps (todo closeout 3,
// pre-review todo attempts 2, remediation cycles 2) remain as **local tighteners
// inside** the shared cap (`tightenLocalCap`). Cursor per-script `loop_limit`
// bounds a script's contributions to `min(loop_limit, global remaining)`;
// `loop_limit: null` (unlimited) is clamped to the global remaining with a
// warning — human-in-the-loop is the floor (`clampLoopLimit`).
//
// Module layout (execution-guidance rule 4): the policy is **pure** and
// Electron-free so both enforcement surfaces share it — the main process keys a
// {@link ContinuationLedger} by `TurnTreeId` for the in-run tighteners (closeout
// / pre-review / remediation), and the renderer applies the pure functions
// against the per-turn-tree counter it keeps on the thread for the drain-time
// held check. Neither imports app services; the ledger holds only numbers.
import type { TurnTreeId } from './turn-tree.ts'

/**
 * Hard cap on machine-initiated new turns per turn tree (decision 5). The floor
 * is human-in-the-loop: once exhausted, a further machine turn is **held** for an
 * explicit human action, which starts a fresh turn tree with a reset budget.
 */
export const DEFAULT_CONTINUATION_BUDGET = 5

/**
 * A turn-tree-bound view of the shared budget, handed to the in-run machine-turn
 * mechanisms (closeout / pre-review / remediation). Each asks for one grant per
 * new turn it wants to run; the mechanism keeps its own local cap but stops as
 * soon as either its local cap or the shared budget is hit (decision 5, "local
 * tighteners inside the shared cap"). A plain interface (no Electron), so the
 * pure loop and post-turn orchestration consume it without importing the host
 * ledger singleton (execution-guidance rule 4).
 */
export interface ContinuationGrant {
  /**
   * Try to consume one machine-initiated new turn from the shared budget.
   * Returns `true` and increments the shared counter when budget remains;
   * `false` when exhausted (the mechanism must stop — a further turn is held for
   * a human). First-come in completion order.
   */
  tryGrant(): boolean
  /** Machine turns still available in the shared budget. */
  remaining(): number
}

/** Remaining machine turns for a turn tree at `used`, never negative. */
export function remainingBudget(used: number, cap: number = DEFAULT_CONTINUATION_BUDGET): number {
  return Math.max(0, cap - used)
}

/** Whether another machine-initiated turn is within budget (decision 5). */
export function canContinue(used: number, cap: number = DEFAULT_CONTINUATION_BUDGET): boolean {
  return used < cap
}

/**
 * A local per-mechanism cap (closeout 3, pre-review 2, remediation 2) **tightened
 * to the shared budget**: the effective number of turns a mechanism may still run
 * is `min(localCap, remaining)`. So local caps can only ever *lower* the shared
 * cap, never raise it (decision 5, "local tighteners inside the shared cap").
 */
export function tightenLocalCap(
  localCap: number,
  used: number,
  cap: number = DEFAULT_CONTINUATION_BUDGET,
): number {
  return Math.max(0, Math.min(localCap, remainingBudget(used, cap)))
}

/** Result of clamping a Cursor per-script `loop_limit` to the global budget. */
export interface LoopLimitClamp {
  /** The enforced limit: `min(loop_limit, remaining)`, or `remaining` when null. */
  limit: number
  /** True when a `null` (unlimited) `loop_limit` was clamped to the global budget. */
  clampedFromNull: boolean
  /** Human-readable warning when an unlimited `loop_limit` was clamped (decision 5). */
  warning?: string
}

/**
 * Clamp a Cursor per-script `loop_limit` to the global budget (decision 5): a
 * numeric limit is bounded to `min(loop_limit, remaining)`; `null` (Cursor's
 * "unlimited") is clamped to the global remaining and flagged with a warning
 * because human-in-the-loop is the floor — no script may loop the agent forever.
 */
export function clampLoopLimit(
  loopLimit: number | null,
  used: number,
  cap: number = DEFAULT_CONTINUATION_BUDGET,
): LoopLimitClamp {
  const remaining = remainingBudget(used, cap)
  if (loopLimit === null) {
    return {
      limit: remaining,
      clampedFromNull: true,
      warning: `loop_limit: null (unlimited) clamped to the global auto-continuation budget (${String(remaining)} remaining of ${String(cap)}) — human-in-the-loop is the floor`,
    }
  }
  return { limit: Math.max(0, Math.min(loopLimit, remaining)), clampedFromNull: false }
}

/**
 * The authoritative in-process continuation ledger: one machine-turn counter per
 * {@link TurnTreeId} (decision 5, "a single counter per turn tree"). The main
 * process owns a long-lived instance so the in-run tighteners (closeout /
 * pre-review / remediation) of a single run share one counter; the renderer's
 * drain-time surface uses the pure functions above against the counter it keeps
 * on the thread. Branded `TurnTreeId` keys make it impossible to mix a raw
 * string in by accident (execution-guidance rule 3).
 */
export class ContinuationLedger {
  private readonly counts = new Map<TurnTreeId, number>()
  private readonly cap: number

  constructor(cap: number = DEFAULT_CONTINUATION_BUDGET) {
    this.cap = cap
  }

  /** Machine turns already spent in this turn tree (0 for an unseen id). */
  used(id: TurnTreeId): number {
    return this.counts.get(id) ?? 0
  }

  /** Machine turns still available in this turn tree. */
  remaining(id: TurnTreeId): number {
    return remainingBudget(this.used(id), this.cap)
  }

  /**
   * Try to grant one machine-initiated new turn (decision 5). Grants **first-come
   * in completion order** — the caller that asks first while budget remains wins;
   * increments the counter and returns `true`. When exhausted, returns `false`
   * and the counter is untouched (the caller holds the work for a human).
   */
  tryGrant(id: TurnTreeId): boolean {
    if (!canContinue(this.used(id), this.cap)) return false
    this.counts.set(id, this.used(id) + 1)
    return true
  }

  /**
   * The effective number of turns a local mechanism (its own `localCap`) may
   * still run in this turn tree: `min(localCap, remaining)` (decision 5).
   */
  effectiveLocalCap(id: TurnTreeId, localCap: number): number {
    return tightenLocalCap(localCap, this.used(id), this.cap)
  }

  /** Clamp a per-script `loop_limit` against this turn tree's remaining budget. */
  clampLoopLimit(id: TurnTreeId, loopLimit: number | null): LoopLimitClamp {
    return clampLoopLimit(loopLimit, this.used(id), this.cap)
  }

  /**
   * Seed a turn tree's spent count — used when the main process resumes a turn
   * tree whose earlier machine turns were spent on another surface (the
   * renderer's queue-drain continuations), so both surfaces share one counter.
   * Never lowers a count already recorded in this process (monotonic within a
   * turn tree); a human reset uses {@link forget} instead.
   */
  seed(id: TurnTreeId, used: number): void {
    const seeded = Math.max(0, Math.floor(used))
    if (seeded > this.used(id)) this.counts.set(id, seeded)
  }

  /** Drop a turn tree's counter — a human action started a fresh turn tree. */
  forget(id: TurnTreeId): void {
    this.counts.delete(id)
  }
}
