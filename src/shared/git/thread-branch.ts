/** True when a bound thread branch differs from the checked-out branch. */
export function threadGitBranchMismatch(
  threadBranch: string | undefined,
  currentBranch: string | null,
): boolean {
  return Boolean(threadBranch && currentBranch && threadBranch !== currentBranch)
}

export function threadGitBranchMismatchMessage(threadBranch: string): string {
  return `This thread is for branch "${threadBranch}". Check it out, or continue on the current branch.`
}
