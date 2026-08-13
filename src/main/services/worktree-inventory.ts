/**
 * The management surface behind Settings → Storage → Worktrees.
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
import { lstat, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type {
  WorktreeInventoryEntry,
  WorktreePackageCleanupResult,
  WorktreePackageDirectory,
  WorktreeRemovalResult,
  WorktreeSizeResult,
} from '@shared/types/worktree.ts'
import { getDefaultBranch } from './github/git-service.ts'
import { runSerialized } from './storage/write-queue.ts'
import { clearThreadWorktree, getThreadMeta } from './thread-store.ts'
import {
  changedPaths,
  expectedThreadWorktreePath,
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

export interface CleanupWorktreePackagesInput extends WorktreeInventoryInput {
  path: string
  /** False previews the exact eligible directories; true rescans and removes them. */
  remove: boolean
}

/**
 * Dependency trees created by common package managers. Generic build folders
 * (`dist`, `build`, `target`) are deliberately absent: they can hold authored
 * or irreplaceable output. Every match must also be ignored by Git before it is
 * offered, so a checked-in `vendor` or `Pods` tree is never touched.
 */
const PACKAGE_DIRECTORY_NAMES = new Set([
  'node_modules',
  'bower_components',
  '.pnpm-store',
  '.venv',
  'venv',
  'vendor',
  'Pods',
  '.gradle',
])
const PACKAGE_DIRECTORY_PATHS = new Set(['.yarn/cache', 'vendor/bundle', 'Carthage/Build'])

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
  const gitDir = await runWorktreeGit(worktreePath, ['rev-parse', '--absolute-git-dir']).catch(
    () => null,
  )
  if (!gitDir) return null
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
  ]).catch(() => null)
  if (!status) return null
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

/** Linked checkouts only: the primary and selected project checkouts are never storage to manage. */
function linkedRecords(
  records: WorktreeRecord[],
  excludedCheckoutRoots: readonly string[],
): WorktreeRecord[] {
  return records.filter((record) => {
    if (record.bare) return false
    try {
      const path = resolve(record.path)
      return excludedCheckoutRoots.every((root) => path !== resolve(root))
    } catch {
      return false
    }
  })
}

interface InventoryRepository {
  /** The primary checkout Git uses to inspect the repository. */
  repositoryRoot: string
  /** The selected project's offset inside its own checkout. */
  projectRelativePath: string
  /** The checkout represented by the selected project, also omitted from the managed list. */
  projectCheckoutRoot: string
  records: WorktreeRecord[]
}

function relativeInside(parent: string, child: string): string | null {
  const value = relative(resolve(parent), resolve(child))
  if (value === '..' || value.startsWith(`..${sep}`)) return null
  return value
}

async function repositoryFromLiveProject(projectRoot: string): Promise<InventoryRepository | null> {
  try {
    const location = await repositoryLocation(projectRoot)
    const records = await listProjectWorktrees(location.repositoryRoot)
    const primaryCheckout = records.find((record) => !record.bare)?.path
    if (!primaryCheckout) return null
    return {
      repositoryRoot: primaryCheckout,
      projectRelativePath: location.projectRelativePath,
      projectCheckoutRoot: location.repositoryRoot,
      records,
    }
  } catch {
    return null
  }
}

/**
 * Find a repository anchor without depending on the selected checkout still
 * existing. Copse owns a stable per-project parent directory for its linked
 * checkouts; any surviving child can ask Git for the whole repository's
 * inventory. The saved project path is then matched back to the checkout Git
 * registered for it, preserving nested-project offsets without trusting a
 * renderer-supplied fallback path.
 */
async function resolveInventoryRepository(
  projectId: string,
  projectRoot: string,
): Promise<InventoryRepository | null> {
  const live = await repositoryFromLiveProject(projectRoot)
  if (live) return live

  const managedParent = dirname(expectedThreadWorktreePath(projectId, 'inventory-anchor'))
  const savedProjectLocation = relativeInside(managedParent, projectRoot)
  const [savedCheckoutName, ...savedProjectParts] = savedProjectLocation?.split(sep) ?? []
  const savedProjectRelativePath = savedProjectParts.join(sep)
  const children = await readdir(managedParent, { withFileTypes: true }).catch(() => [])
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!child.isDirectory()) continue
    const candidate = join(managedParent, child.name)
    if (managedThreadIdForPath(projectId, candidate) === null) continue
    const repository = await repositoryFromLiveProject(candidate)
    if (!repository) continue
    const projectRecord = repository.records.find(
      (record) => !record.bare && relativeInside(record.path, projectRoot) !== null,
    )
    if (projectRecord) {
      const projectRelativePath = relativeInside(projectRecord.path, projectRoot)
      if (projectRelativePath === null) continue
      return {
        repositoryRoot: repository.repositoryRoot,
        projectRelativePath,
        projectCheckoutRoot: projectRecord.path,
        records: repository.records,
      }
    }
    // `git worktree prune` can remove the missing checkout's record before the
    // user opens Storage. Its saved path still carries the layout Copse owns:
    // `<project parent>/<thread id>/<project-relative path>`. A surviving child
    // under that same project-scoped parent is therefore a sufficient anchor.
    if (!savedCheckoutName) continue
    return {
      repositoryRoot: repository.repositoryRoot,
      projectRelativePath: savedProjectRelativePath,
      projectCheckoutRoot: join(managedParent, savedCheckoutName),
      records: repository.records,
    }
  }
  return null
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
  const repository = await resolveInventoryRepository(input.projectId, input.projectRoot)
  if (!repository) return []
  const { repositoryRoot } = repository
  const records = linkedRecords(repository.records, [
    repository.repositoryRoot,
    repository.projectCheckoutRoot,
  ])
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
  const repository = await resolveInventoryRepository(input.projectId, input.projectRoot)
  if (!repository) throw new Error('That project repository is no longer available')
  const { repositoryRoot, projectRelativePath } = repository
  const target = resolve(input.path)
  const record = linkedRecords(repository.records, [
    repository.repositoryRoot,
    repository.projectCheckoutRoot,
  ]).find((candidate) => {
    try {
      return resolve(candidate.path) === target
    } catch {
      return false
    }
  })
  if (!record) throw new Error('That worktree is not registered with this repository')
  return { repositoryRoot, projectRelativePath, record }
}

/** Canonical root for a renderer-named checkout, after repository validation. */
export async function resolveRegisteredWorktreePath(input: WorktreePathInput): Promise<string> {
  return (await requireRegisteredWorktree(input)).record.path
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

function isPackageDirectory(relativePath: string, name: string): boolean {
  const portablePath = relativePath.split(sep).join('/')
  return (
    PACKAGE_DIRECTORY_NAMES.has(name) ||
    [...PACKAGE_DIRECTORY_PATHS].some(
      (path) => portablePath === path || portablePath.endsWith(`/${path}`),
    )
  )
}

/**
 * Find dependency directories without descending into them. A Git ignore check
 * is the final eligibility test: known names narrow the search, while ignore
 * state proves the checkout itself treats the contents as reproducible.
 */
async function findPackageDirectories(root: string): Promise<string[]> {
  const found: string[] = []
  const stack: Array<{ absolute: string; relative: string }> = [{ absolute: root, relative: '' }]
  let visited = 0
  while (stack.length > 0 && visited < SIZE_ENTRY_BUDGET) {
    const current = stack.pop()
    if (!current) break
    const entries = await readdir(current.absolute, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (++visited > SIZE_ENTRY_BUDGET) break
      if (!entry.isDirectory() || entry.name === '.git') continue
      const childRelative = current.relative ? join(current.relative, entry.name) : entry.name
      if (isPackageDirectory(childRelative, entry.name)) {
        const ignored = await runWorktreeGit(root, [
          'check-ignore',
          '--quiet',
          '--',
          childRelative,
        ]).catch(() => null)
        if (ignored?.code === 0) {
          found.push(childRelative)
          // The whole dependency tree is eligible, so nothing below it needs
          // a separate listing (and walking node_modules would be enormous).
          continue
        }
        // A tracked `vendor` may still contain ignored `vendor/bundle`; keep
        // walking a known-but-ineligible parent so the narrower match appears.
      }
      stack.push({ absolute: join(current.absolute, entry.name), relative: childRelative })
    }
  }
  return found.sort((a, b) => a.localeCompare(b))
}

async function describePackageDirectories(
  root: string,
  paths: string[],
): Promise<WorktreePackageDirectory[]> {
  const directories: WorktreePackageDirectory[] = []
  // Like the row-size queue in the renderer, walk one tree at a time. A large
  // monorepo can have dozens of workspace-level node_modules directories;
  // parallel walks would turn a cleanup preview into an I/O spike.
  for (const path of paths) {
    const measured = await measureTree(join(root, path))
    directories.push({ path, bytes: measured.bytes, truncated: measured.truncated })
  }
  return directories
}

/** Preview or remove reproducible package-manager directories from one checkout. */
export async function cleanupWorktreePackages(
  input: CleanupWorktreePackagesInput,
): Promise<WorktreePackageCleanupResult> {
  const { repositoryRoot, record } = await requireRegisteredWorktree(input)
  const threadId = managedThreadIdForPath(input.projectId, record.path)
  if (threadId && input.runningThreadIds.has(threadId)) {
    return { status: 'blocked-running', path: record.path, threadId }
  }

  return runSerialized(`worktree-manager:${repositoryRoot}`, async () => {
    const paths = await findPackageDirectories(record.path)
    const directories = await describePackageDirectories(record.path, paths)
    const bytes = directories.reduce((total, directory) => total + directory.bytes, 0)
    const truncated = directories.some((directory) => directory.truncated)
    if (input.remove) {
      for (const path of paths) await rm(join(record.path, path), { recursive: true, force: true })
    }
    return {
      status: input.remove ? 'cleaned' : 'ready',
      path: record.path,
      directories,
      bytes,
      truncated,
    }
  })
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
