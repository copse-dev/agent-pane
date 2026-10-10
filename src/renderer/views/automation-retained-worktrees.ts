import type { AutomationRetainedReason, AutomationRetainedWorktree } from '@shared/types'

const REASON_LABEL: Record<AutomationRetainedReason, string> = {
  'uncommitted-changes': 'has uncommitted changes',
  'unmerged-commits': 'has commits that are not merged',
  'unpushed-pull-request': 'has a pull request branch that is not pushed',
  'in-use': 'still has a terminal or background process open',
}

/** One short clause for a blocking run, e.g. “Main check” has uncommitted changes (a.ts, b.ts). */
export function describeRetainedWorktree(
  run: AutomationRetainedWorktree,
  name: string = run.title,
): string {
  const paths = run.paths?.length ? ` (${run.paths.join(', ')})` : ''
  return `“${name}” ${REASON_LABEL[run.reason]}${paths}`
}

/** One short clause per blocking run, joined for a single status line. */
export function describeRetainedWorktrees(retained: readonly AutomationRetainedWorktree[]): string {
  return retained.map((run) => describeRetainedWorktree(run)).join('; ')
}
