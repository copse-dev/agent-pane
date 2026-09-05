/**
 * Git allows one checkout per branch across a repository's worktrees, and says
 * so in two different shapes:
 *
 *   fatal: 'main' is already used by worktree at '/path/to/checkout'   (git switch)
 *   fatal: 'main' is already checked out at '/path/to/checkout'        (git worktree add)
 *
 * Both are dead ends until the *other* checkout releases the branch, and
 * neither message says how. Isolated thread worktrees make this reachable
 * without the user ever running Git themselves — an agent that ran
 * `git checkout main` inside its own worktree parks the branch there
 * indefinitely — so the recovery has to travel with the error.
 */
const HELD_BY_WORKTREE = /already (?:used by worktree|checked out) at '([^']+)'/

/** The worktree already holding the branch, or null for any other failure. */
export function branchHolderPath(gitError: string): string | null {
  return HELD_BY_WORKTREE.exec(gitError)?.[1] ?? null
}

/** Names the holder and the single command that frees the branch. */
export function branchHeldByWorktreeMessage(branch: string, holderPath: string): string {
  return (
    `Branch "${branch}" is checked out in another worktree, and Git allows only one at a time: ` +
    `${holderPath}. Free it by switching that checkout to another branch — ` +
    `git -C "${holderPath}" checkout --detach — or choose a different branch here.`
  )
}

/**
 * Rewrite a raw Git failure as the recoverable form when a worktree holds the
 * branch; any other failure is returned untouched so its own detail survives.
 */
export function describeBranchCheckoutFailure(branch: string, gitError: string): string {
  const holderPath = branchHolderPath(gitError)
  return holderPath ? branchHeldByWorktreeMessage(branch, holderPath) : gitError
}
