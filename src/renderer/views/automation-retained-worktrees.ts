import type { AutomationRetainedReason, AutomationRetainedWorktree } from '@shared/types'

const REASON_LABEL: Record<AutomationRetainedReason, string> = {
  'uncommitted-changes': 'has uncommitted changes',
  'unmerged-commits': 'has commits that are not merged',
  'unpushed-pull-request': 'has a pull request branch that is not pushed',
  'in-use': 'still has a terminal or background process open',
}

/** One short clause per blocking run, e.g. “Main check” has uncommitted changes (a.ts, b.ts). */
export function describeRetainedWorktrees(retained: readonly AutomationRetainedWorktree[]): string {
  return retained
    .map((run) => {
      const paths = run.paths?.length ? ` (${run.paths.join(', ')})` : ''
      return `“${run.title}” ${REASON_LABEL[run.reason]}${paths}`
    })
    .join('; ')
}
