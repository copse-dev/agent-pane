import { z } from 'zod'
import { defineTool } from '@shared/types'
import { getGithubRepoSlug } from '../services/github/git-service.ts'
import {
  approvePr,
  enablePrAutoMerge,
  markPrReady,
  rerunFailedPrRuns,
} from '../services/github/gh-pr-actions-service.ts'
import type { PrActionResult } from '@shared/types/git.ts'
import type { PrRef } from '../services/github/backend/backend.ts'

const prActionParams = z.object({
  number: z.number().int().positive().describe('Pull request number.'),
  owner: z
    .string()
    .optional()
    .describe('Repository owner. Omit to use the current workspace repository.'),
  repo: z
    .string()
    .optional()
    .describe('Repository name. Omit to use the current workspace repository.'),
})

/** Resolve owner/repo from args, falling back to the workspace origin slug. */
async function resolveRef(args: {
  number: number
  owner?: string | undefined
  repo?: string | undefined
}): Promise<PrRef | null> {
  let { owner, repo } = args
  if (!owner || !repo) {
    const slug = await getGithubRepoSlug()
    const [slugOwner, slugRepo] = slug?.split('/') ?? []
    owner = owner ?? slugOwner
    repo = repo ?? slugRepo
  }
  if (!owner || !repo) return null
  return { owner, repo, number: args.number }
}

function formatResult(result: PrActionResult): string {
  const prefix = result.ok ? (result.noop ? 'No change' : 'Done') : 'Failed'
  return `${prefix}: ${result.message}`
}

async function runAction(
  args: { number: number; owner?: string | undefined; repo?: string | undefined },
  action: (ref: PrRef) => Promise<PrActionResult>,
): Promise<string> {
  const ref = await resolveRef(args)
  if (!ref) {
    return 'Failed: could not resolve the repository. Pass owner and repo, or open a GitHub workspace.'
  }
  return formatResult(await action(ref))
}

export const ghRerunFailedCiTool = defineTool({
  name: 'gh_pr_rerun_failed_ci',
  description:
    "Re-run the failed CI workflow runs on a pull request's head branch via the GitHub PR backend. Mutating action — asks for approval.",
  parameters: prActionParams,
  execute: async (args) => runAction(args, rerunFailedPrRuns),
})

export const ghApprovePrTool = defineTool({
  name: 'gh_pr_approve',
  description:
    'Approve a pull request via the GitHub PR backend. Mutating action — asks for approval.',
  parameters: prActionParams,
  execute: async (args) => runAction(args, approvePr),
})

export const ghMarkPrReadyTool = defineTool({
  name: 'gh_pr_mark_ready',
  description:
    'Mark a draft pull request ready for review via the GitHub PR backend. No-op if it is already ready. Mutating action — asks for approval.',
  parameters: prActionParams,
  execute: async (args) => runAction(args, markPrReady),
})

export const ghEnableAutoMergeTool = defineTool({
  name: 'gh_pr_enable_auto_merge',
  description:
    "Enable merge-when-ready (auto-merge) on a pull request, choosing the repository's preferred merge strategy. Mutating action — asks for approval.",
  parameters: prActionParams,
  execute: async (args) => runAction(args, enablePrAutoMerge),
})

/** All PR lifecycle write tools, registered together. */
export const ghPrActionTools = [
  ghRerunFailedCiTool,
  ghApprovePrTool,
  ghMarkPrReadyTool,
  ghEnableAutoMergeTool,
]
