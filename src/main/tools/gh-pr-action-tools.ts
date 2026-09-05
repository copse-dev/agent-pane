import { z } from 'zod'
import { defineTool } from '@shared/types'
import { getGithubRepoSlug } from '../services/github/git-service.ts'
import {
  approvePr,
  enablePrAutoMerge,
  markPrReady,
  rerunFailedPrRuns,
} from '../services/github/gh-pr-actions-service.ts'
import { createPrForThread } from '../services/github/pr-create-service.ts'
import { getThreadExecutionContext } from '../services/thread-execution-context.ts'
import type { PrActionResult } from '@shared/types/git.ts'
import type { PrRef } from '../services/github/backend/backend.ts'
import type { ToolRegistry } from '../services/tool-registry.ts'

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

/** Fill missing owner/repo halves from the workspace origin slug. */
async function resolveOwnerRepo(
  owner: string | undefined,
  repo: string | undefined,
): Promise<{ owner: string; repo: string } | null> {
  if (!owner || !repo) {
    const slug = await getGithubRepoSlug()
    const [slugOwner, slugRepo] = slug?.split('/') ?? []
    owner = owner ?? slugOwner
    repo = repo ?? slugRepo
  }
  if (!owner || !repo) return null
  return { owner, repo }
}

/** Resolve owner/repo from args, falling back to the workspace origin slug. */
async function resolveRef(args: {
  number: number
  owner?: string | undefined
  repo?: string | undefined
}): Promise<PrRef | null> {
  const target = await resolveOwnerRepo(args.owner, args.repo)
  return target ? { ...target, number: args.number } : null
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

export const ghCreatePrTool = defineTool({
  name: 'gh_pr_create',
  description:
    'Open a pull request for the current branch. Copse appends the "Co-Authored-By: Copse" attribution trailer to the body and links the PR to this thread (the sidebar PR chip) from the created PR itself — prefer this over `run_shell gh pr create`, which does neither. Mutating action — asks for approval.',
  parameters: z.object({
    title: z.string().min(1).describe('Pull request title.'),
    body: z
      .string()
      .optional()
      .default('')
      .describe('Pull request body in markdown. The attribution trailer is appended for you.'),
    base: z
      .string()
      .optional()
      .describe("Branch to merge into. Omit to use the repository's default branch."),
    head: z
      .string()
      .optional()
      .describe('Branch holding the changes. Omit to use the current branch. Must be pushed.'),
    draft: z.boolean().optional().default(false).describe('Open the PR as a draft.'),
    owner: z
      .string()
      .optional()
      .describe(
        'Repository owner. Omit to use the current workspace repository; pass together with repo.',
      ),
    repo: z
      .string()
      .optional()
      .describe(
        'Repository name. Omit to use the current workspace repository; pass together with owner.',
      ),
  }),
  execute: async ({ title, body, base, head, draft, owner, repo }) => {
    // The create sequence itself lives in pr-create-service so the composer's
    // "Create PR" dialog runs the identical path — attribution trailer, target
    // resolution and thread linking included. This tool is now just the model's
    // door onto it.
    const outcome = await createPrForThread(
      { title, body, base, head, draft, owner, repo },
      getThreadExecutionContext(),
    )
    return formatResult(outcome)
  },
})

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

/**
 * All PR lifecycle write tools. `ToolDefinition<TArgs>` is invariant in TArgs,
 * so the heterogeneous list is only usable where names suffice (unregister);
 * registration goes through {@link registerGhPrActionTools} so both lists live
 * in this file and are edited together.
 */
export const ghPrActionTools = [
  ghCreatePrTool,
  ghRerunFailedCiTool,
  ghApprovePrTool,
  ghMarkPrReadyTool,
  ghEnableAutoMergeTool,
]

/** Register every PR lifecycle write tool (idempotent — register overwrites). */
export function registerGhPrActionTools(registry: ToolRegistry): void {
  registry.register(ghCreatePrTool)
  registry.register(ghRerunFailedCiTool)
  registry.register(ghApprovePrTool)
  registry.register(ghMarkPrReadyTool)
  registry.register(ghEnableAutoMergeTool)
}
