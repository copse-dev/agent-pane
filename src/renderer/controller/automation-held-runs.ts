import { automationRunBlock } from '@shared/automation-run-state.ts'
import type { RunSignals } from './sidebar-thread.ts'

/**
 * Finished runs of one schedule that still hold a git worktree. A running run
 * owns its checkout legitimately, and a retired one has already let it go, so
 * neither counts: what is left is what can block the schedule's next run.
 */
export function heldAutomationRuns(runs: readonly RunSignals[]): RunSignals[] {
  return runs.filter(
    (run) =>
      automationRunBlock(run) === null &&
      run.automationPendingStart !== true &&
      run.worktree !== undefined &&
      run.worktree.retiredAt === undefined,
  )
}

export function heldRunsLabel(count: number): string {
  return `${String(count)} held`
}

export function heldRunsTooltip(count: number): string {
  return `${String(count)} finished run${count === 1 ? ' still holds' : 's still hold'} a worktree. Right-click for Clean up finished runs.`
}
