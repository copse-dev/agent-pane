import { runWorktreeGit } from './worktree-manager.ts'
import { isPatchAbsorbedInHistory } from './todo-consolidation.ts'

/**
 * Crash sweep for todo-worker checkouts (phase 3e,
 * docs/plans/parallel-todo-workers.md). A batch interrupted mid-run leaves
 * `todo-<id>` worktrees behind. One whose worker branch is already absorbed —
 * patch-equivalent content in the thread history, per the consolidator's probe
 * — is pruned; anything unmerged or dirty is retained and reported so the
 * existing worktree inventory surfaces it instead of deleting work quietly.
 */
export interface TodoWorkerSweepInput {
  projectId: string
  projectRoot: string
  threadId: string
}

export async function sweepTodoWorkerOrphans(
  input: TodoWorkerSweepInput,
): Promise<{ pruned: string[]; retained: Array<{ todoId: string; reason: string }> }> {
  const report: { pruned: string[]; retained: Array<{ todoId: string; reason: string }> } = {
    pruned: [],
    retained: [],
  }
  const list = await runWorktreeGit(input.projectRoot, ['worktree', 'list', '--porcelain', '-z'])
  if (list.code !== 0) return report

  for (const token of list.stdout.split('\0')) {
    if (!token.startsWith('worktree ')) continue
    const path = token.slice('worktree '.length)
    // Only checkouts whose basename carries the todo- owner prefix; a project
    // root that merely contains "todo-" in its directory name must not match.
    const base = path.split('/').pop() ?? ''
    if (!base.startsWith('todo-')) continue
    const todoId = base.slice('todo-'.length)
    if (!todoId) continue

    // Dirty checkouts always survive the sweep: the worker's partial output on
    // disk has no commit anywhere else.
    const status = await runWorktreeGit(path, ['status', '--porcelain=v1', '-z'])
    if (status.code !== 0) {
      report.retained.push({ todoId, reason: 'unavailable' })
      continue
    }
    if (status.stdout) {
      report.retained.push({ todoId, reason: 'dirty' })
      continue
    }

    const branchResult = await runWorktreeGit(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (branchResult.code !== 0 || !branchResult.stdout.trim()) {
      report.retained.push({ todoId, reason: 'detached' })
      continue
    }
    const branch = branchResult.stdout.trim()

    const head = await runWorktreeGit(path, ['rev-parse', 'HEAD'])
    if (head.code !== 0 || !head.stdout.trim()) {
      report.retained.push({ todoId, reason: 'unavailable' })
      continue
    }
    const absorbed = await isPatchAbsorbedInHistory(input.projectRoot, head.stdout.trim())
    if (!absorbed) {
      report.retained.push({ todoId, reason: 'unmerged' })
      continue
    }

    const remove = await runWorktreeGit(input.projectRoot, ['worktree', 'remove', path])
    if (remove.code !== 0) {
      report.retained.push({ todoId, reason: 'unavailable' })
      continue
    }
    await runWorktreeGit(input.projectRoot, ['branch', '-d', branch]).catch(() => undefined)
    report.pruned.push(todoId)
  }
  return report
}
