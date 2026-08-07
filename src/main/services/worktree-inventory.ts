/**
 * The management surface behind Settings → Sources → Worktrees.
 *
 * `worktree-manager.ts` owns the lifecycle a thread drives — allocate on first
 * message, validate on reopen, retire only when provably safe. This module is
 * the other half: what a *person* needs to see and do about the linked
 * checkouts that lifecycle left on disk. It reads (never allocates), joins each
 * checkout back to the thread it was created for, measures its footprint on
 * demand, and removes one when the user asks — including the cases the
 * automatic path deliberately refuses (dirty, unmerged), which are exactly the
 * ones that accumulate.
 *
 * Everything here is scoped to checkouts Git already has registered for the
 * project's repository. A path the renderer names is matched against that list
 * before anything touches it, so the delete button cannot be steered at an
 * arbitrary directory.
 */
import { lstat, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type {
  WorktreeInventoryEntry,
  WorktreeRemovalResult,
  WorktreeSizeResult,
} from '@shared/types/worktree.ts'
import { getDefaultBranch, isInsideGitWorkTree } from './github/git-service.ts'
import { runSerialized } from './storage/write-queue.ts'
import { clearThreadWorktree, getThreadMeta } from './thread-store.ts'
import {
  changedPaths,
  listProjectWorktrees,
  managedThreadIdForPath,
  releaseWorktreeRoot,
  repositoryLocation,
  runWorktreeGit,
  type WorktreeRecord,
} from './worktree-manager.ts'

/**
 * Ceiling on entries visited while sizing one checkout. A worktree holds a
 * working tree, not the object store, but it can still hold `node_modules` or
 * build output; the budget keeps a single Settings panel from turning into an
 * unbounded filesystem walk. Hitting it reports `truncated` rather than a
 * number that quietly understates the directory.
 */
const SIZE_ENTRY_BUDGET = 400_000

export interface WorktreeInventoryInput {
  projectId: string
  projectRoot: string
  /** Threads with an agent turn in flight; their checkouts are never removable. */
  runningThreadIds: ReadonlySet<string>
}

export interface WorktreePathInput {
  projectId: string
  projectRoot: string
  path: string
}

export interface RemoveWorktreeInput extends WorktreePathInput {
  runningThreadIds: ReadonlySet<string>
  /**
   * Delete a checkout Git would refuse to drop — uncommitted edits, untracked
   * or ignored files. Only ever set from an explicit second confirmation.
   */
  force: boolean
}

function branchRef(branch: string): string {
  return `refs/heads/${branch}`
}

/** Millisecond mtime of a path, or null when it is gone or unreadable. */
async function mtimeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return null
  }
}

async function birthtimeOf(path: string): Promise<number | null> {
  try {
    const stats = await stat(path)
    // Some filesystems report birthtime as 0 (or as the epoch) rather than
    // admitting they don't track it; treat that as "unknown" instead of 1970.
    return stats.birthtimeMs > 0 ? stats.birthtimeMs : null
  } catch {
    return null
  }
}

/**
 * When Git last touched this checkout. The linked worktree's own index lives
 * under `<common git dir>/worktrees/<name>/index` and is rewritten by every
 * checkout, add, commit, or status refresh — a far better "last used" signal
 * than the checkout root's mtime, which only moves when a top-level entry does.
 */
async function lastGitActivity(worktreePath: string): Promise<number | null> {
  const gitDir = await runWorktreeGit(worktreePath, ['rev-parse', '--absolute-git-dir'])
  if (gitDir.code !== 0) return null
  const dir = gitDir.stdout.trim()
  if (!dir) return null
  const index = await mtimeOf(join(dir, 'index'))
  return index ?? (await mtimeOf(dir))
}

/** Uncommitted work in a checkout, ignored files included (`git worktree remove` deletes those). */
async function inspectChanges(worktreePath: string): Promise<string[] | null> {
  const status = await runWorktreeGit(worktreePath, [
    'status',
    '--porcelain=v1',
    '-z',
    '--ignored=matching',
  ])
  if (status.code !== 0) return null
  return changedPaths(status.stdout)
}

async function isMerged(
  repositoryRoot: string,
  branch: string,
  baseBranch: string | null,
): Promise<boolean | null> {
  if (!baseBranch || baseBranch === branch) return null
  const result = await runWorktreeGit(repositoryRoot, [
    'merge-base',
    '--is-ancestor',
    branchRef(branch),
    branchRef(baseBranch),
  ])
  // Exit 1 is a real answer ("not contained"); anything else means the question
  // could not be asked — a missing base branch, say — so the UI shows nothing
  // rather than implying unmerged work.
  return result.code === 0 ? true : result.code === 1 ? false : null
}

/** Linked checkouts only: the project's own checkout and any bare entry are not "worktrees" to manage. */
function linkedRecords(records: WorktreeRecord[], repositoryRoot: string): WorktreeRecord[] {
  return records.filter((record) => {
    if (record.bare) return false
    try {
      return resolve(record.path) !== resolve(repositoryRoot)
    } catch {
      return false
    }
  })
}

async function describeRecord(
  input: WorktreeInventoryInput,
  repositoryRoot: string,
  defaultBranch: string | null,
  record: WorktreeRecord,
): Promise<WorktreeInventoryEntry> {
  const threadId = managedThreadIdForPath(input.projectId, record.path)
  const meta = threadId ? await getThreadMeta(input.projectId, threadId).catch(() => null) : null
  // A thread whose metadata points somewhere else no longer owns this checkout;
  // saying so is what makes an abandoned copy safe to reclaim.
  const recorded = meta?.worktree
  const linked = recorded !== undefined && resolve(recorded.path) === resolve(record.path)
  const baseBranch = linked ? recorded.baseBranch : null
  const [changed, gitActivity, rootMtime, dirCreatedAt] = await Promise.all([
    inspectChanges(record.path),
    lastGitActivity(record.path),
    mtimeOf(record.path),
    birthtimeOf(record.path),
  ])
  // Without recorded metadata, "merged" is still worth answering against the
  // repository's default branch — that is the question a person clearing out
  // old checkouts is actually asking.
  const merged = record.branch
    ? await isMerged(repositoryRoot, record.branch, baseBranch ?? defaultBranch)
    : null
  const lastUsedCandidates = [meta?.updatedAt ?? null, gitActivity, rootMtime].filter(
    (value): value is number => typeof value === 'number' && value > 0,
  )

  return {
    path: record.path,
    branch: record.branch,
    baseBranch,
    head: record.head,
    detached: record.detached,
    locked: record.locked,
    prunable: record.prunable,
    managed: threadId !== null,
    usage:
      threadId && meta
        ? {
            threadId,
            title: meta.title,
            updatedAt: meta.updatedAt,
            archived: meta.archivedAt != null,
            linked,
            running: input.runningThreadIds.has(threadId),
          }
        : null,
    createdAt: linked ? recorded.createdAt : dirCreatedAt,
    lastUsedAt: lastUsedCandidates.length > 0 ? Math.max(...lastUsedCandidates) : null,
    changedCount: changed?.length ?? null,
    merged,
  }
}

/**
 * Every linked checkout of the project's repository, newest activity first.
 *
 * A project that is not a Git working tree (or has been removed) has no
 * worktrees rather than an error: the panel it feeds lists several kinds of
 * source side by side, and an unrelated project shape should read as "nothing
 * here", not as a failure of the whole section.
 */
export async function listWorktreeInventory(
  input: WorktreeInventoryInput,
): Promise<WorktreeInventoryEntry[]> {
  if (!(await isInsideGitWorkTree(input.projectRoot))) return []
  const { repositoryRoot } = await repositoryLocation(input.projectRoot)
  const records = linkedRecords(await listProjectWorktrees(repositoryRoot), repositoryRoot)
  if (records.length === 0) return []
  const defaultBranch = await getDefaultBranch(repositoryRoot)
  const entries = await Promise.all(
    records.map((record) => describeRecord(input, repositoryRoot, defaultBranch, record)),
  )
  return entries.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
}

/** Resolve a renderer-supplied path to a checkout Git actually has registered for this repository. */
async function requireRegisteredWorktree(
  input: WorktreePathInput,
): Promise<{ repositoryRoot: string; projectRelativePath: string; record: WorktreeRecord }> {
  const { repositoryRoot, projectRelativePath } = await repositoryLocation(input.projectRoot)
  const target = resolve(input.path)
  const record = linkedRecords(await listProjectWorktrees(repositoryRoot), repositoryRoot).find(
    (candidate) => {
      try {
        return resolve(candidate.path) === target
      } catch {
        return false
      }
    },
  )
  if (!record) throw new Error('That worktree is not registered with this repository')
  return { repositoryRoot, projectRelativePath, record }
}

/**
 * Bytes held by one checkout's working tree. Symlinks are counted as links, not
 * followed, so a link out of the checkout can neither inflate the total nor
 * walk the caller into an unrelated tree.
 */
async function measureTree(root: string): Promise<{
  bytes: number
  fileCount: number
  truncated: boolean
}> {
  let bytes = 0
  let fileCount = 0
  let visited = 0
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    if (dir === undefined) break
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (++visited > SIZE_ENTRY_BUDGET) return { bytes, fileCount, truncated: true }
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      try {
        bytes += (await lstat(full)).size
        fileCount += 1
      } catch {
        // Raced with the agent or a build; one missing file should not fail the total.
      }
    }
  }
  return { bytes, fileCount, truncated: false }
}

/** On-demand footprint for one checkout — the list renders without it, then fills it in. */
export async function measureWorktreeSize(input: WorktreePathInput): Promise<WorktreeSizeResult> {
  const { record } = await requireRegisteredWorktree(input)
  const measured = await measureTree(record.path)
  return { path: record.path, ...measured }
}

/**
 * Remove one linked checkout on the user's instruction.
 *
 * Two states stop it. A running thread is refused outright — deleting the tree
 * an agent is writing into corrupts that turn, and no confirmation makes that
 * a good idea. Uncommitted or ignored content is refused *unless* `force`,
 * which is what the second confirmation grants: `git worktree remove --force`
 * deletes those files, so the user has to have seen them first.
 *
 * On success the owning thread's worktree metadata is dropped so the thread
 * reverts to the shared project checkout instead of failing to validate on its
 * next message, and the branch is offered to `git branch -d` — which deletes it
 * only if it is fully merged, and leaves unmerged work alone.
 */
export async function removeWorktree(input: RemoveWorktreeInput): Promise<WorktreeRemovalResult> {
  const { repositoryRoot, projectRelativePath, record } = await requireRegisteredWorktree(input)
  const threadId = managedThreadIdForPath(input.projectId, record.path)
  if (threadId && input.runningThreadIds.has(threadId)) {
    return { status: 'blocked-running', path: record.path, threadId }
  }

  // Serialize against allocation/retirement on the same repository: `git
  // worktree` bookkeeping is not concurrency-safe, and the manager uses this
  // very key.
  return runSerialized(`worktree-manager:${repositoryRoot}`, async () => {
    if (!input.force) {
      const changed = await inspectChanges(record.path)
      if (changed === null || changed.length > 0) {
        return { status: 'blocked-dirty', path: record.path, changed: changed ?? [] }
      }
    }

    const args = ['worktree', 'remove', ...(input.force ? ['--force'] : []), record.path]
    const removed = await runWorktreeGit(repositoryRoot, args)
    if (removed.code !== 0) {
      const detail = (removed.stderr || removed.stdout).trim()
      throw new Error(detail ? `Cannot remove worktree: ${detail}` : 'Cannot remove worktree')
    }
    releaseWorktreeRoot(resolve(record.path, projectRelativePath))
    if (threadId) await clearThreadWorktree(input.projectId, threadId).catch(() => false)

    // `-d` (not `-D`): a branch carrying unmerged commits survives the checkout
    // it was living in, so the work is still reachable afterwards.
    const branchDeleted = record.branch
      ? (await runWorktreeGit(repositoryRoot, ['branch', '-d', record.branch])).code === 0
      : false
    return { status: 'removed', path: record.path, branch: record.branch, branchDeleted }
  })
}
