/**
 * Startup budget reporting (issue #994).
 *
 * The event-loop watchdog (#995) already records how long each boot phase took,
 * and `getStartupPhaseTimeline()` has been exported for a "startup-budget
 * diagnostics" consumer since it landed — this is that consumer.
 *
 * Why it is needed. Every expensive thing boot does is proportional to something
 * CI does not have: how many threads the profile holds, how large the workspace
 * tree is, how many MCP servers are configured. CI only ever boots a pristine
 * profile against a small checkout, so those costs measure ~0 there and a
 * regression in them is invisible by construction. A multi-second startup was
 * reported by a user, not by a test.
 *
 * This module cannot fix that on its own — an aged-profile boot fixture is the
 * real gate, and is still #994's remaining work. What it does is make the number
 * visible and self-reporting on every launch, so "startup feels slow" turns into
 * a timeline anyone can paste into an issue, and a phase that blows its ceiling
 * says so in the log rather than waiting to be profiled.
 *
 * Budgets are deliberately generous: this is a smoke alarm for a phase that has
 * grown an order of magnitude, not a benchmark. A machine under load should not
 * produce noise. Records carry only phase names and durations — never paths,
 * prompts, or file contents.
 */

import { getStartupPhaseTimeline, type PhaseDuration } from './event-loop-watchdog.ts'

export interface PhaseBudget {
  phase: string
  budgetMs: number
}

export interface BudgetOverrun extends PhaseBudget {
  actualMs: number
}

/**
 * Per-phase ceilings, in milliseconds.
 *
 * Chosen as "an order of magnitude worse than healthy, on a slow machine" rather
 * than as targets. Phases absent here are unbudgeted — a new phase has to opt in
 * deliberately, because a wrong guess would either cry wolf on every launch or
 * pass silently and be worse than nothing.
 */
export const STARTUP_PHASE_BUDGETS: readonly PhaseBudget[] = [
  { phase: 'reap-gortex', budgetMs: 1_000 },
  // Up to nine process probes, one of them a network round trip. The probe now
  // starts before handler registration and this phase measures only the residual
  // wait afterwards, so the number here is what the probe still costs boot — a
  // phase this spawn-heavy is exactly where cost creeps.
  { phase: 'tool-availability', budgetMs: 4_000 },
  { phase: 'sandbox-init', budgetMs: 2_000 },
  // Scales with the number of threads in the profile — invisible to CI today.
  { phase: 'llm-history-migration', budgetMs: 3_000 },
  { phase: 'window-create', budgetMs: 2_000 },
  { phase: 'register-handlers', budgetMs: 1_000 },
  // Scales with workspace tree size and MCP server count — also invisible to CI.
  { phase: 'skills-mcp', budgetMs: 5_000 },
]

/** Phases that ran longer than their budget. Pure; empty when everything fits. */
export function findBudgetOverruns(
  timeline: readonly PhaseDuration[],
  budgets: readonly PhaseBudget[] = STARTUP_PHASE_BUDGETS,
): BudgetOverrun[] {
  const byPhase = new Map(budgets.map((b) => [b.phase, b.budgetMs]))
  const overruns: BudgetOverrun[] = []
  for (const entry of timeline) {
    const budgetMs = byPhase.get(entry.phase)
    if (budgetMs !== undefined && entry.ms > budgetMs) {
      overruns.push({ phase: entry.phase, budgetMs, actualMs: entry.ms })
    }
  }
  return overruns
}

/** Total measured boot time — the sum of every phase that has a duration. */
export function totalStartupMs(timeline: readonly PhaseDuration[]): number {
  return timeline.reduce((sum, entry) => sum + entry.ms, 0)
}

/** `app-ready:0ms reap-gortex:20ms …` — the same shape the watchdog logs. */
export function formatStartupTimeline(timeline: readonly PhaseDuration[]): string {
  return timeline.map((p) => `${p.phase}:${String(Math.round(p.ms))}ms`).join(' ')
}

export function formatOverrun(overrun: BudgetOverrun): string {
  return `${overrun.phase} took ${String(Math.round(overrun.actualMs))}ms (budget ${String(overrun.budgetMs)}ms)`
}

/**
 * Log the boot timeline, and warn about any phase over budget. Called once at
 * `boot-complete`. Never throws: a diagnostic that can break startup is worse
 * than the regression it is watching for.
 */
export function reportStartupBudget(
  timeline: readonly PhaseDuration[] = getStartupPhaseTimeline(),
): void {
  try {
    console.log(
      `[startup] boot-complete in ${String(Math.round(totalStartupMs(timeline)))}ms — ${formatStartupTimeline(timeline)}`,
    )
    const overruns = findBudgetOverruns(timeline)
    for (const overrun of overruns) {
      console.warn(`[startup] over budget: ${formatOverrun(overrun)}`)
    }
  } catch {
    // Diagnostics must never take the app down.
  }
}
