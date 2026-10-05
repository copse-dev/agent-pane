import type { SidebarThread } from './sidebar-thread.ts'

/** More than this many runs waiting on the user collapse into one row. */
export const PENDING_COLLAPSE_ABOVE = 3
/** This many failed runs from one schedule collate into one row; a single one stays its own. */
export const FAILED_COLLATE_AT = 2

/** What one schedule shows while its finished runs are folded away. */
export type AutomationFoldEntry =
  | { kind: 'run'; run: SidebarThread }
  | { kind: 'pending'; runs: SidebarThread[] }
  | { kind: 'failed'; runs: SidebarThread[] }

/**
 * The rows one schedule keeps in view when it is collapsed. Runs that need the
 * user or are working stay their own rows, and so does a failure, so none is
 * hidden inside a fold; the schedule's heading carries every finished run.
 * Many of one kind collapse so a busy schedule cannot fill the list: more than
 * {@link PENDING_COLLAPSE_ABOVE} waiting runs, or {@link FAILED_COLLATE_AT} or
 * more failed ones. Needs you comes first, then working, then failed; runs keep
 * their incoming (newest first) order inside each.
 */
export function foldAutomationRuns(
  runs: readonly SidebarThread[],
  needsYou: (threadId: string) => boolean,
): AutomationFoldEntry[] {
  const pending = runs.filter((run) => needsYou(run.id))
  const rest = runs.filter((run) => !needsYou(run.id))
  const working = rest.filter((run) => run.status === 'running')
  const failed = rest.filter((run) => run.status === 'error')
  return [
    ...(pending.length > PENDING_COLLAPSE_ABOVE
      ? [{ kind: 'pending' as const, runs: pending }]
      : pending.map((run) => ({ kind: 'run' as const, run }))),
    ...working.map((run) => ({ kind: 'run' as const, run })),
    ...(failed.length >= FAILED_COLLATE_AT
      ? [{ kind: 'failed' as const, runs: failed }]
      : failed.map((run) => ({ kind: 'run' as const, run }))),
  ]
}
