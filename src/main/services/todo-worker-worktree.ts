import { errorMessage } from '@shared/errors.ts'
import type { TodoItem } from '@shared/types/todo.ts'
import { runWorktreeGit } from './worktree-manager.ts'
import { repositoryLocation } from './worktree-manager.ts'

/**
 * Host-side commit of a finished worker's output onto its own branch (phase 2 of
 * docs/plans/parallel-todo-workers.md). The host, never the model, commits so
 * "one todo becomes one commit" is deterministic and retirement is safe to judge
 * mechanically: a clean cherry-pick later proves the content was absorbed.
 *
 * Committing happens on pass *and* fail — a failed acceptance check holds the
 * item in_progress and keeps its branch unmerged, but the work survives on the
 * retained branch instead of being lost with the checkout.
 */
export interface TodoWorkerCommit {
  branch: string
  sha: string | null
  /** Null sha means there was nothing to commit (worker produced no file changes). */
  committed: boolean
}

export function todoWorkerBranchName(todoId: string, collision = 0): string {
  const compact = todoId.toLowerCase().replace(/[^a-z0-9]/g, '')
  const base = `copse/todo-worker/${compact === '' ? 'item' : compact}`
  return collision > 0 ? `${base}-${String(collision + 1)}` : base
}

export function todoWorkerCommitMessage(item: TodoItem): string {
  const candidate = item.content.trim().split('\n')[0]?.trim()
  const firstLine = candidate === undefined || candidate === '' ? 'Todo worker output' : candidate
  return `${firstLine}\n\nHost-side commit of the local todo worker's output for plan item ${item.id}.`
}

/** Pick the next free `copse/todo-worker/<id>[N]` branch in this repository. */
export async function resolveTodoWorkerBranch(
  projectRoot: string,
  todoId: string,
): Promise<string> {
  for (let collision = 0; collision < 50; collision++) {
    const branch = todoWorkerBranchName(todoId, collision)
    const check = await runWorktreeGit(projectRoot, [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ])
    if (check.code === 1) return branch
    if (check.code !== 0) {
      throw new Error(`Cannot inspect todo worker branch ${branch}: ${check.stderr.trim()}`)
    }
  }
  throw new Error(`Cannot find a free branch for todo worker ${todoId}`)
}

export async function commitTodoWorkerOutput(input: {
  worktreePath: string
  branch: string
  item: TodoItem
  authorName: string
  authorEmail: string
}): Promise<TodoWorkerCommit> {
  const { worktreePath, item } = input
  try {
    const add = await runWorktreeGit(worktreePath, ['add', '-A'])
    if (add.code !== 0) throw new Error(`git add failed: ${(add.stderr || add.stdout).trim()}`)
    // Probe the index after staging. Ignored-only build output is intentionally
    // not a commit: `git add -A` cannot stage it, and attempting the commit
    // would turn the normal no-source-change outcome into a failure.
    const staged = await runWorktreeGit(worktreePath, [
      'diff',
      '--cached',
      '--quiet',
      '--exit-code',
    ])
    if (staged.code === 0) return { branch: input.branch, sha: null, committed: false }
    if (staged.code !== 1) {
      throw new Error(`git diff --cached failed: ${(staged.stderr || staged.stdout).trim()}`)
    }

    const commit = await runWorktreeGit(
      worktreePath,
      [
        'commit',
        '-m',
        todoWorkerCommitMessage(item),
        '--author',
        `${input.authorName} <${input.authorEmail}>`,
      ],
      {
        ...process.env,
        GIT_AUTHOR_NAME: input.authorName,
        GIT_AUTHOR_EMAIL: input.authorEmail,
        GIT_COMMITTER_NAME: input.authorName,
        GIT_COMMITTER_EMAIL: input.authorEmail,
      },
    )
    if (commit.code !== 0) {
      throw new Error(`git commit failed: ${(commit.stderr || commit.stdout).trim()}`)
    }
    const head = await runWorktreeGit(worktreePath, ['rev-parse', 'HEAD'])
    const sha = head.stdout.trim()
    if (head.code !== 0 || sha === '') throw new Error('git rev-parse HEAD failed after commit')
    return { branch: input.branch, sha, committed: true }
  } catch (error) {
    // A commit failure must not lose the worker's files: they are still on disk
    // in the worktree, which the caller retains on failure. The error text goes
    // back to the parent via the normal todo_worker_done path.
    throw new Error(`Todo worker commit failed on branch ${input.branch}: ${errorMessage(error)}`, {
      cause: error,
    })
  }
}

/** True when the worker branch's HEAD commit is already an ancestor of `baseRef`. */
export async function todoWorkerBranchMerged(
  projectRoot: string,
  branch: string,
  baseRef: string,
): Promise<boolean> {
  const result = await runWorktreeGit(projectRoot, [
    'merge-base',
    '--is-ancestor',
    `refs/heads/${branch}`,
    baseRef,
  ])
  return result.code === 0
}

/** Repository top level for a project root, re-exported for the runner's use. */
export async function todoWorkerRepositoryRoot(projectRoot: string): Promise<string> {
  return (await repositoryLocation(projectRoot)).repositoryRoot
}
