import type { ThreadChangeSummary } from '../types/git.ts'

/**
 * Tooltip / aria-label for a sidebar row's "changes" glyph, or null when the
 * thread has nothing unlanded. The row shows no counts or dot: the detail lives
 * here only.
 */
export function describeThreadChanges(summary: ThreadChangeSummary | null): string | null {
  if (!summary) return null
  const unpushed = summary.unpushed ?? 0
  if (unpushed > 0) {
    const commits = `${String(unpushed)} unpushed commit${unpushed === 1 ? '' : 's'}`
    return summary.dirty ? `${commits} and uncommitted changes` : commits
  }
  return summary.dirty ? 'Uncommitted changes' : null
}

export function sameThreadChangeSummary(
  a: ThreadChangeSummary | null,
  b: ThreadChangeSummary | null,
): boolean {
  return describeThreadChanges(a) === describeThreadChanges(b)
}
