import type { SidebarThread } from './sidebar-thread.ts'

/**
 * Finished runs of one schedule that still hold a git worktree. A running run
 * owns its checkout legitimately, and a retired one has already let it go, so
 * neither counts: what is left is what can block the schedule's next run.
 */
export function heldAutomationRuns(runs: readonly SidebarThread[]): SidebarThread[] {
  return runs.filter(
    (run) =>
      run.status !== 'running' &&
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
