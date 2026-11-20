import { inspectThreadReadRoot, resolveThreadExecutionContext } from './thread-execution-context.ts'
import { ensureWorkingTreeWatched } from './search/workspace-index-watcher.ts'
import { checkoutGitBranch } from './github/git-service.ts'

/** Passive native Git reads watch only an existing, owned checkout. */
export async function resolveWatchedGitRoot(
  projectId: string,
  threadId: string,
): Promise<string | null> {
  const root = await inspectThreadReadRoot(projectId, threadId)
  if (root) ensureWorkingTreeWatched(root)
  return root
}

/** Actual submit/checkout actions retain the execution lifecycle's restoration. */
export async function resolveWatchedGitExecutionRoot(
  projectId: string,
  threadId: string,
): Promise<string> {
  const { root } = await resolveThreadExecutionContext(projectId, threadId)
  ensureWorkingTreeWatched(root)
  return root
}

/** A requested branch switch owns its checkout's execution lifecycle. */
export async function checkoutThreadGitBranch(
  projectId: string,
  threadId: string,
  branch: string,
): Promise<void> {
  const root = await resolveWatchedGitExecutionRoot(projectId, threadId)
  await checkoutGitBranch(branch, root)
  // This deliberate mutation owns branch adoption; a later passive refresh no
  // longer rewrites metadata as an incidental side effect.
  await resolveWatchedGitExecutionRoot(projectId, threadId)
}
