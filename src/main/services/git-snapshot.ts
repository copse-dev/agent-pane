/**
 * A commit of the working tree as it stands — tracked modifications, staged
 * changes and untracked files, `.gitignore` respected — made without touching
 * HEAD, the real index or the tree itself: a throwaway index seeded from HEAD,
 * `add -A` into it, `write-tree`, `commit-tree`. Three places needed this and
 * had each written it out: the worktree backup before an agent edits, the
 * container run's carry-in, and the remote e2e push. The sequence lives here
 * once; what a caller names the commit, where it hangs it and how long it
 * keeps it stay with the caller.
 *
 * Over an injected runner so the same steps run against a local checkout, a
 * remote workspace over SSH (the caller then allocates the index where git
 * runs) or a script's synchronous git wrapped in a promise. The runner throws
 * on a failed command; nothing here interprets exit codes.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Run git with these arguments (and extra environment), resolving with trimmed stdout. */
export type SnapshotGitRunner = (args: string[], env?: Record<string, string>) => Promise<string>

export interface WorkingTreeSnapshotOptions {
  /** The commit message. */
  message: string
  /** Author and committer, so a checkout with no `user.name` still commits. */
  identity: { name: string; email: string }
  /**
   * Where the throwaway index goes. Allocated under the temp directory and
   * removed afterwards when omitted; a caller whose git runs elsewhere (a
   * remote workspace) allocates it there and cleans up itself.
   */
  indexPath?: string
}

export interface WorkingTreeSnapshot {
  /** The snapshot commit, or HEAD itself when the tree is clean. */
  sha: string
  /** Whether the tree differed from HEAD, i.e. whether a commit was made. */
  dirty: boolean
}

/**
 * Snapshot the working tree. A clean tree yields HEAD and no commit; a
 * checkout with no HEAD yet (a fresh repository) yields a root commit of
 * whatever the tree holds.
 */
export async function snapshotWorkingTree(
  git: SnapshotGitRunner,
  options: WorkingTreeSnapshotOptions,
): Promise<WorkingTreeSnapshot> {
  const head = await git(['rev-parse', '--verify', 'HEAD']).then(
    (sha) => sha,
    () => null,
  )
  const own = options.indexPath === undefined ? mkdtempSync(join(tmpdir(), 'copse-index-')) : null
  const indexPath = options.indexPath ?? join(own ?? '', 'index')
  try {
    const index = { GIT_INDEX_FILE: indexPath }
    // Seed the throwaway index from HEAD so deletions show up in the snapshot.
    if (head !== null) await git(['read-tree', 'HEAD'], index)
    await git(['add', '-A'], index)
    const tree = await git(['write-tree'], index)
    if (head !== null && tree === (await git(['rev-parse', 'HEAD^{tree}']))) {
      return { sha: head, dirty: false }
    }
    const sha = await git([
      '-c',
      `user.name=${options.identity.name}`,
      '-c',
      `user.email=${options.identity.email}`,
      'commit-tree',
      tree,
      ...(head !== null ? ['-p', head] : []),
      '-m',
      options.message,
    ])
    return { sha, dirty: true }
  } finally {
    if (own !== null) rmSync(own, { recursive: true, force: true })
  }
}
