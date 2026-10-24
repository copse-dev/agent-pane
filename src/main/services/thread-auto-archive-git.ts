import type { Thread } from '@shared/types/thread.ts'
import type { GhPrDetails } from '@shared/types/git.ts'
import {
  inspectRemovalBlockers,
  runWorktreeGit,
  validateThreadWorktree,
} from './worktree-manager.ts'

const SHA = /^[a-f0-9]{40,64}$/i

async function cleanHead(path: string): Promise<string | null> {
  const [status, head, blockers] = await Promise.all([
    runWorktreeGit(path, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=normal',
      '--ignored=matching',
      '--ignore-submodules=none',
    ]),
    runWorktreeGit(path, ['rev-parse', '--verify', 'HEAD']),
    // Also catches unpublished commits inside otherwise clean submodules.
    inspectRemovalBlockers(path, { includeIgnored: false }),
  ])
  if (
    blockers.dirty ||
    status.code !== 0 ||
    status.stdoutTruncated ||
    head.code !== 0 ||
    head.stdoutTruncated
  )
    return null
  // Only ignored dependency and scratch directories are disposable. Arbitrary
  // ignored files (including local source, notes and secrets) require review.
  for (const record of status.stdout.split('\0').filter(Boolean)) {
    const entry = record.slice(3)
    const disposable =
      record.startsWith('!! ') &&
      entry.endsWith('/') &&
      entry.split('/').some((part) => part === 'node_modules' || part === '.tmp' || part === 'tmp')
    if (!disposable) return null
  }
  const sha = head.stdout.trim()
  return SHA.test(sha) ? sha : null
}

/** Verify the entire checkout, including packages outside a nested project root. */
export async function inspectAutoArchiveCheckout(
  projectId: string,
  projectRoot: string,
  thread: Omit<Thread, 'messages'>,
  merged: readonly GhPrDetails[],
): Promise<{ head: string; path: string } | string> {
  if (!thread.worktree || thread.worktree.retiredAt)
    return 'This thread has no active isolated checkout.'
  const checkout = await validateThreadWorktree({
    projectId,
    threadId: thread.id,
    projectRoot,
    worktree: thread.worktree,
  })
  const sha = await cleanHead(checkout.path)
  if (!sha) return 'The checkout contains local work or could not be fully inspected.'
  // A PR head is a completion witness even when a squash/rebase merge changed
  // destination commit identities and the source branch has been pruned.
  // Merely being pushed to an arbitrary remote branch does not prove completion.
  for (const pr of merged) {
    if (!pr.headRefOid || !SHA.test(pr.headRefOid)) continue
    if (pr.headRefOid.toLowerCase() === sha.toLowerCase()) return { head: sha, path: checkout.path }
    const result = await runWorktreeGit(checkout.path, [
      'merge-base',
      '--is-ancestor',
      sha,
      pr.headRefOid,
    ])
    if (result.code === 0) return { head: sha, path: checkout.path }
  }
  return 'There are commits whose merge could not be verified.'
}

export async function checkoutStillClean(path: string, expectedHead: string): Promise<boolean> {
  return (await cleanHead(path)) === expectedHead
}
