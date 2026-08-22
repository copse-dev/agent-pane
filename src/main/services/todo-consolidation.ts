import { runWorktreeGit } from './worktree-manager.ts'
import { errorMessage } from '@shared/errors.ts'

/**
 * Consolidation of absorbed todo-worker branches onto the thread branch
 * (phase 3, docs/plans/parallel-todo-workers.md). The host cherry-picks each
 * worker commit in plan order; a conflict aborts that pick and holds the item
 * for the parent agent, which resolves with its normal edit tools and retries
 * via `consolidate_todo_workers`.
 */

export interface ConsolidateInput {
  projectRoot: string
  /** Ordered todo ids: plan order decides pick order. */
  orderedTodoIds: readonly string[]
  /** Exact batch outputs, so a collision-suffixed retry cannot resolve to an older branch. */
  workers?: readonly { todoId: string; branch: string; sha: string }[]
}

export interface TodoWorkerConflict {
  todoId: string
  branch: string
  sha: string
  conflictingPaths: string[]
}

export type ConsolidationOutcome =
  | { todoId: string; status: 'merged'; sha: string }
  | {
      todoId: string
      status: 'conflicted'
      branch: string
      sha: string
      conflictingPaths: string[]
    }
  | { todoId: string; status: 'missing-commit'; branch: string }
  | { todoId: string; status: 'already-merged'; branch: string }

export interface ConsolidateReport {
  outcomes: ConsolidationOutcome[]
  /** True when every outcome is merged or already-merged. */
  clean: boolean
  /** Human-readable summary routed to the parent through the tool-result channel. */
  message: string
}

function branchFor(todoId: string): string {
  const compact = todoId.toLowerCase().replace(/[^a-z0-9]/g, '') || 'item'
  return `copse/todo-worker/${compact}`
}

/** Resolve the worker branch's HEAD sha, or null when the branch has no unique commit. */
async function branchHead(projectRoot: string, branch: string): Promise<string | null> {
  const result = await runWorktreeGit(projectRoot, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ])
  return result.code === 0 ? result.stdout.trim() || null : null
}

async function isAncestor(projectRoot: string, sha: string, baseRef: string): Promise<boolean> {
  const result = await runWorktreeGit(projectRoot, ['merge-base', '--is-ancestor', sha, baseRef])
  return result.code === 0
}

/**
 * Patch-equivalence probe: whether a commit with the worker's diff already
 * exists in HEAD's history. A cherry-pick re-creates the commit with a new
 * sha, so sha ancestry misses everything this branch ever absorbed; `git cherry`
 * marks a commit `-` exactly when an equivalent patch (same patch-id) is
 * already in the upstream history.
 */
async function isPatchAbsorbed(projectRoot: string, sha: string): Promise<boolean> {
  return isPatchAbsorbedInHistory(projectRoot, sha)
}

/** Shared with the crash sweep: patch-equivalence of `sha` against HEAD.
 *
 * `git cherry` prints nothing for a commit already in HEAD by sha, `-` for one
 * absorbed by patch-id, and `+` for genuinely new work — so absorbed means "no
 * `+` line", not "saw a `-`". */
export async function isPatchAbsorbedInHistory(projectRoot: string, sha: string): Promise<boolean> {
  const cherry = await runWorktreeGit(projectRoot, ['cherry', 'HEAD', sha])
  if (cherry.code !== 0) return false
  return !cherry.stdout.split('\n').some((line) => line.trimStart().startsWith('+'))
}

/** Conflicted paths from a failed `git cherry-pick` in this repository. */
async function conflictedPaths(cwd: string): Promise<string[]> {
  const result = await runWorktreeGit(cwd, ['diff', '--name-only', '--diff-filter=U'])
  if (result.code !== 0) return []
  return result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

/**
 * Cherry-pick one worker commit. Never leaves a conflicted index behind:
 * failure aborts the pick before returning, and the thread checkout's own
 * dirty state is untouched because cherry-pick refuses to run over it.
 */
export async function consolidateTodoWorkers(input: ConsolidateInput): Promise<ConsolidateReport> {
  const { projectRoot, orderedTodoIds } = input
  const exactWorkers = new Map(input.workers?.map((worker) => [worker.todoId, worker]))

  // A dirty thread checkout must not be merged into — phase 2's invariant: the
  // host never commits, stashes, or resets the parent's uncommitted work.
  const status = await runWorktreeGit(projectRoot, ['status', '--porcelain=v1', '-z'])
  if (status.code !== 0) {
    return {
      outcomes: [],
      clean: false,
      message: `Cannot consolidate: git status failed: ${(status.stderr || status.stdout).trim()}`,
    }
  }
  if (status.stdout) {
    return {
      outcomes: [],
      clean: false,
      message:
        'Cannot consolidate yet: the workspace has uncommitted changes. Commit or stash them first, then call consolidate_todo_workers again.',
    }
  }

  const outcomes: ConsolidationOutcome[] = []
  for (const todoId of orderedTodoIds) {
    const exact = exactWorkers.get(todoId)
    const branch = exact?.branch ?? branchFor(todoId)
    try {
      const sha = exact?.sha ?? (await branchHead(projectRoot, branch))
      if (!sha) {
        outcomes.push({ todoId, status: 'missing-commit', branch })
        continue
      }

      const alreadyMerged =
        (await isAncestor(projectRoot, sha, 'HEAD')) || (await isPatchAbsorbed(projectRoot, sha))
      if (alreadyMerged) {
        outcomes.push({ todoId, status: 'already-merged', branch })
        continue
      }

      // Later picks are still attempted after a conflict so one bad item never
      // hides a good one; each failure aborts its own pick before reporting.
      const pick = await runWorktreeGit(projectRoot, ['cherry-pick', sha])
      if (pick.code !== 0) {
        const paths = await conflictedPaths(projectRoot)
        await runWorktreeGit(projectRoot, ['cherry-pick', '--abort'])
        outcomes.push({ todoId, status: 'conflicted', branch, sha, conflictingPaths: paths })
        continue
      }
      outcomes.push({ todoId, status: 'merged', sha })
    } catch (error) {
      outcomes.push({
        todoId,
        status: 'conflicted',
        branch,
        sha: '',
        conflictingPaths: [errorMessage(error)],
      })
    }
  }

  const clean = outcomes.every((o) => o.status === 'merged' || o.status === 'already-merged')
  const lines: string[] = []
  for (const o of outcomes) {
    switch (o.status) {
      case 'merged':
        lines.push(`Merged ${o.todoId} (${o.sha.slice(0, 8)}).`)
        break
      case 'already-merged':
        lines.push(`${o.todoId}: already in history.`)
        break
      case 'missing-commit':
        lines.push(`${o.todoId}: worker branch ${o.branch} has no commit to merge.`)
        break
      case 'conflicted':
        lines.push(
          `${o.todoId}: CONFLICT with ${o.conflictingPaths.join(', ') || 'the workspace'} — fix these files, then call consolidate_todo_workers to retry (or discard this item).`,
        )
        break
    }
  }
  return { outcomes, clean, message: lines.join('\n') || 'Nothing to consolidate.' }
}

/** Explicitly abandon one worker branch: the itemized deletion confirmation path. */
export async function discardTodoWorkerBranch(
  projectRoot: string,
  todoId: string,
): Promise<{ discarded: boolean; branch: string; detail?: string }> {
  const branch = branchFor(todoId)
  const deleteResult = await runWorktreeGit(projectRoot, ['branch', '-D', branch])
  if (deleteResult.code !== 0) {
    return {
      discarded: false,
      branch,
      detail: (deleteResult.stderr || deleteResult.stdout).trim(),
    }
  }
  return { discarded: true, branch }
}
