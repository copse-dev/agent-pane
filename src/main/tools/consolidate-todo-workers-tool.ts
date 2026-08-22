import { z } from 'zod'
import { defineTool } from '@shared/types'
import { getTodoConsolidationRunner } from '../services/todo-consolidation-runner.ts'

/**
 * Retry consolidation of absorbed todo-worker branches (phase 3,
 * docs/plans/parallel-todo-workers.md). Registered only while worker merges are
 * pending: the parent resolves conflicting files with its normal edit tools,
 * calls this to re-pick the held worker commits, and repeats until the report
 * is clean. `{ discard: [...] }` abandons a conflicted worker branch instead —
 * the explicit confirmation the worktree invariants require before unmerged
 * work is destroyed.
 */
export const consolidateTodoWorkersTool = defineTool({
  name: 'consolidate_todo_workers',
  description:
    'Retry merging finished parallel todo workers into the workspace. Call after fixing any reported conflict files. Pass discard to abandon a worker branch whose conflicts you decide not to resolve; discarding permanently deletes that branch.',
  parameters: z.object({
    discard: z
      .array(z.string())
      .optional()
      .describe('Todo ids whose worker branches should be abandoned instead of merged'),
  }),
  async execute({ discard }) {
    const runner = getTodoConsolidationRunner()
    if (!runner) {
      return 'Error: no pending todo worker merges to consolidate.'
    }
    return runner(discard ?? [])
  },
})
