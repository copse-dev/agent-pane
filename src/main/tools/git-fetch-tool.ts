import { z } from 'zod'
import { defineTool } from '@shared/types'
import { getAgentExecutionRoot } from '../services/execution-root.ts'
import { fetchOriginRefs, GIT_FETCH_MAX_REFS } from '../services/git-fetch-origin.ts'
import { isActiveSshWorkspace } from '../services/ssh-workspace/execution-target.ts'
import { runWorktreeGit } from '../services/worktree-manager.ts'

/**
 * Update `refs/remotes/origin/*` from the project's origin without a shell
 * approval. See git-fetch-origin.ts for the boundary.
 */
export const gitFetchTool = defineTool({
  name: 'git_fetch',
  description:
    "Fetch branches or pull-request heads from the project's origin, without a shell approval. " +
    'Use this instead of run_shell `git fetch origin <branch>`, which has no network in the project sandbox and prompts. ' +
    'Updates only remote-tracking refs: a branch lands at refs/remotes/origin/<branch>, refs/pull/<n>/head at refs/remotes/origin/pr/<n>. ' +
    'Never touches local branches, HEAD or the working tree; merge or check out afterwards yourself. Returns each ref and its SHA. ' +
    'Origin only, from an https/ssh URL; no other remotes, URLs, refspecs or options.',
  parameters: z.strictObject({
    refs: z
      .array(z.string().min(1))
      .min(1)
      .max(GIT_FETCH_MAX_REFS)
      .describe('Branch names on origin (e.g. "main", "feature/x") and/or "refs/pull/<n>/head".'),
  }),
  async execute({ refs }) {
    if (isActiveSshWorkspace())
      return 'git_fetch is not available in SSH workspaces; run `git fetch` through run_shell.'
    const root = getAgentExecutionRoot()
    if (!root) return 'No workspace open.'
    return fetchOriginRefs(root, refs, runWorktreeGit)
  },
})
