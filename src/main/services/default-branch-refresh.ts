import { getDefaultBranch } from './github/git-service.ts'
import { listLocalProjectRoots } from './workspace.ts'
import { fetchDefaultBranch, hasOriginRemote } from './worktree-manager.ts'

/**
 * How often to refresh each local project's cached `origin/<default>` ref.
 *
 * Thread creation only fetches it opportunistically (`allocateThreadWorktree`
 * in worktree-manager.ts), and that fetch is itself best-effort: failures are
 * logged by `fetchDefaultBranch` but otherwise absorbed. Without this, a
 * project's default branch can only drift further behind `origin` between
 * successful app launches/fetches — sometimes for days — until a new thread
 * happens to fetch it successfully.
 */
export const DEFAULT_BRANCH_REFRESH_INTERVAL_MS = 60 * 60 * 1000

async function refreshOneProject(root: string): Promise<void> {
  try {
    if (!(await hasOriginRemote(root))) return
    const branch = await getDefaultBranch(root)
    if (!branch) return
    // A failed fetch exits non-zero rather than throwing; fetchDefaultBranch
    // reports it, and the project keeps the `origin/<default>` ref it had.
    await fetchDefaultBranch(root, branch)
  } catch (err) {
    // Best-effort: the origin or default-branch lookup itself failed.
    console.warn('[copse-panel] default branch refresh failed for', root, err)
  }
}

/** Refresh every local project's `origin/<default>` ref once, concurrently. */
export async function refreshAllDefaultBranches(): Promise<void> {
  await Promise.allSettled(listLocalProjectRoots().map(refreshOneProject))
}

/** Startup and hourly upkeep; errors are swallowed per project, never fatal to app startup. */
export function startDefaultBranchRefresh(): void {
  void refreshAllDefaultBranches()
  const timer = setInterval(
    () => void refreshAllDefaultBranches(),
    DEFAULT_BRANCH_REFRESH_INTERVAL_MS,
  )
  timer.unref()
}
