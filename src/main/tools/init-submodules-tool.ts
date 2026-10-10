import { z } from 'zod'
import { defineTool } from '@shared/types'
import { getAgentExecutionRoot } from '../services/execution-root.ts'
import { populateWorktreeSubmodules } from '../services/worktree-submodules.ts'

/**
 * Check out submodules in the thread's worktree on demand.
 *
 * A thread worktree starts with every submodule directory empty (cloning them
 * all up front is slow and most threads touch none). This copies the ones the
 * project checkout has initialised, offline and from its own module
 * repositories, so it needs no approval: it never reaches the network and only
 * writes inside the thread's private administration directory. Fetching newer
 * submodule commits is a separate, ordinary `git submodule update` through
 * `run_shell`.
 */
export const initSubmodulesTool = defineTool({
  name: 'init_submodules',
  description:
    "Check out submodules in this thread's worktree. They start empty. Copies the submodules the project checkout has already initialised, offline, at the commits this branch records; no network, no approval. " +
    'Pass `paths` to check out only some (top-level submodule paths); omit it for all. A submodule the project never initialised is reported, not fetched: run `git submodule update --init <path>` through run_shell for that.',
  parameters: z.object({
    paths: z
      .array(z.string().min(1))
      .optional()
      .describe('Top-level submodule paths to check out, as in `.gitmodules`. Omit for all.'),
  }),
  async execute({ paths }) {
    const root = getAgentExecutionRoot()
    if (!root) return 'No workspace open.'
    const result = await populateWorktreeSubmodules(root, paths ? { only: paths } : {})
    const lines = [
      result.populated.length > 0
        ? `Checked out: ${result.populated.join(', ')}`
        : 'Checked out nothing.',
    ]
    if (result.skipped.length > 0)
      lines.push(`Already present or not empty: ${result.skipped.join(', ')}`)
    if (result.notInitialised.length > 0)
      lines.push(
        `Never initialised in the project checkout (run \`git submodule update --init <path>\` to fetch): ${result.notInitialised.join(', ')}`,
      )
    if (result.failed.length > 0) lines.push(`Failed: ${result.failed.join(', ')}`)
    return lines.join('\n')
  },
})
