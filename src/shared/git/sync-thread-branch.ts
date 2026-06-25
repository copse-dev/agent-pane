import type { AppStore } from '@shared/store/store.ts'
import { getThreadById, setThreadGitBranch } from '@shared/store/thread-helpers.ts'

/**
 * True when a run_shell command could move HEAD to a different branch. Branch
 * status is global to the working tree, so re-querying it (an IPC + git
 * subprocess) after every shell command is wasteful and—worse—lets a thread
 * silently chase HEAD a different thread moved. We only sync after commands
 * that could actually switch branches; routine `ls`/`npm test` are ignored.
 */
export function shellCommandMayChangeBranch(args: unknown): boolean {
  const command = readShellCommand(args)
  if (!command) return false
  return /\bgit\b[^\n]*\b(checkout|switch|worktree)\b/.test(command)
}

function readShellCommand(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  const command = (args as { command?: unknown }).command
  return typeof command === 'string' ? command : null
}

/** True when a live checkout differs from the thread's bound branch. */
export function threadGitBranchNeedsSync(
  threadBranch: string | undefined,
  currentBranch: string | null,
): currentBranch is string {
  return Boolean(currentBranch && threadBranch !== currentBranch)
}

/** Rebind the thread to the checked-out branch when HEAD moved within the thread. */
export function syncThreadGitBranchIfChanged(
  store: AppStore,
  threadId: string,
  currentBranch: string | null,
): boolean {
  if (!currentBranch) return false
  const thread = getThreadById(store, threadId)
  if (!thread || thread.gitBranch === currentBranch) return false
  setThreadGitBranch(store, threadId, currentBranch)
  return true
}
