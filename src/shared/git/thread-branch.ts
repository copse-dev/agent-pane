/**
 * True when a bound thread branch differs from the checked-out branch.
 *
 * Isolated worktree threads bind `gitBranch` to the worktree branch while the
 * user's project checkout stays put — that is intentional, not a mismatch.
 */
export function threadGitBranchMismatch(
  threadBranch: string | undefined,
  currentBranch: string | null,
  options: { isolatedWorktree?: boolean } = {},
): boolean {
  if (options.isolatedWorktree) return false
  return Boolean(threadBranch && currentBranch && threadBranch !== currentBranch)
}

export function threadGitBranchMismatchMessage(threadBranch: string): string {
  return `This thread is for branch "${threadBranch}". Check it out, or continue on the current branch.`
}
