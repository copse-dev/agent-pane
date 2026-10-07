import { z } from 'zod'
import { defineTool } from '@shared/types'
import { REQUEST_WRITE_ACCESS_TOOL } from '@shared/tools/readonly-tools.ts'
import {
  describeWriteAccessGrant,
  ensureWritableThreadCheckout,
} from '../services/deferred-worktree.ts'

/**
 * Give a deferred-worktree thread its own worktree. Only offered while the
 * thread is still a read-only view of the user's checkout (see `parentTools`).
 *
 * No approval prompt: the project already chose isolation, and allocation is
 * exactly what an eager thread did before its first message. Calling it is
 * optional — any write-capable tool allocates on its own — but calling it
 * first lets the agent name the branch after what it is about to change.
 */
export const requestWriteAccessTool = defineTool({
  name: REQUEST_WRITE_ACCESS_TOOL,
  description:
    "Give this thread its own git worktree and branch so it can edit files, commit, and run commands that write (builds, installs, tests that emit files). Until then the thread is a read-only view of the user's checkout: reading, searching, git inspection, and sandboxed read-only shell commands all work, but nothing can write there. " +
    'Call this once, when you are ready to make changes, with a short description of the change to name the branch. Editing or writing a file also creates the worktree automatically. ' +
    'The result tells you the new working directory and lists any files whose content differs from what you had been reading; re-read those before editing them.',
  parameters: z.object({
    branch_name: z
      .string()
      .max(80)
      .optional()
      .describe(
        'Short description of the change, e.g. "fix login redirect". Becomes the branch name (copse/fix-login-redirect-<id>).',
      ),
  }),
  async execute({ branch_name }) {
    const grant = await ensureWritableThreadCheckout(
      branch_name?.trim() ? { branchTitle: branch_name } : {},
    )
    if (!grant) return 'No thread is active, so there is no checkout to make writable.'
    return describeWriteAccessGrant(grant)
  },
})
