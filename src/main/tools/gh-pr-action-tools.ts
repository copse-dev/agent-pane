import { z } from 'zod'
import { defineTool } from '@shared/types'
import {
  getCurrentBranchName,
  getDefaultBranch,
  getGithubRepoSlug,
} from '../services/github/git-service.ts'
import {
  approvePr,
  createPullRequest,
  enablePrAutoMerge,
  markPrReady,
  rerunFailedPrRuns,
} from '../services/github/gh-pr-actions-service.ts'
import { appendPrBodyAttribution } from '@shared/git/commit-attribution.ts'
import { getThreadExecutionContext } from '../services/thread-execution-context.ts'
import { getThreadModels } from '../services/thread-models.ts'
import { recordThreadPrRefs } from '../services/thread-store.ts'
import { broadcastToAppWindows } from '../windows/app-window-broadcast.ts'
import type { GithubPrRef } from '@shared/git/github-pr-url.ts'
import type { PrActionResult } from '@shared/types/git.ts'
import type { PrRef } from '../services/github/backend/backend.ts'
import type { ToolRegistry } from '../services/tool-registry.ts'
import type { ThreadExecutionContext } from '../services/thread-execution-context.ts'

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

/**
 * Link a freshly created (or rediscovered) PR to the thread that opened it, and
 * push the sidebar update so the chip appears without a relaunch. The ref is
 * built from the coordinates the backend returned — never re-parsed out of the
 * URL, which would silently drop GitHub Enterprise hosts. Best-effort: a PR
 * that opened successfully must not be reported as failed because bookkeeping
 * did not land.
 */
async function linkPrToThread(ref: GithubPrRef, context: ThreadExecutionContext): Promise<void> {
  try {
    const refs = await recordThreadPrRefs(context.projectId, context.threadId, [ref])
    if (!refs) return
    broadcastToAppWindows('threads:pr_refs', context.projectId, [
      { threadId: context.threadId, prRefs: refs },
    ])
  } catch (err) {
    console.warn('[gh_pr_create] linking the PR to its thread failed:', err)
  }
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
    // Half a target is never what the caller meant: splicing one explicit half
    // with the workspace slug's other half would silently aim at a mixed repo.
    if (!owner !== !repo) {
      return 'Failed: pass owner and repo together, or omit both to use the workspace repository.'
    }
    const workspaceSlug = await getGithubRepoSlug()
    const [slugOwner, slugRepo] = workspaceSlug?.split('/') ?? []
    const targetOwner = owner ?? slugOwner
    const targetRepo = repo ?? slugRepo
    if (!targetOwner || !targetRepo) {
      return 'Failed: could not resolve the repository. Pass owner and repo, or open a GitHub workspace.'
    }

    // Branch defaults come from the local checkout, which only describes the
    // workspace repo. For an explicit different target, require both branches
    // rather than guessing from the wrong repository.
    const crossRepo = workspaceSlug !== `${targetOwner}/${targetRepo}`
    if (crossRepo && (!head || !base)) {
      return `Failed: ${targetOwner}/${targetRepo} is not the workspace repository, so pass head and base explicitly — the local checkout cannot supply defaults for another repo.`
    }

    const headBranch = head ?? (await getCurrentBranchName())
    if (!headBranch) {
      return 'Failed: could not resolve the current branch. Pass head with the branch to open the PR from.'
    }
    const baseBranch = base ?? (await getDefaultBranch())
    if (!baseBranch) {
      return "Failed: could not resolve the repository's default branch. Pass base with the branch to merge into."
    }
    if (headBranch === baseBranch) {
      return `Failed: head and base are both ${headBranch}. Commit the work to its own branch first.`
    }

    const context = getThreadExecutionContext()
    const models = context ? getThreadModels(context.threadId) : []
    const result = await createPullRequest({
      owner: targetOwner,
      repo: targetRepo,
      head: headBranch,
      base: baseBranch,
      title,
      body: appendPrBodyAttribution(body, models),
      draft,
    })

    if (result.ok && result.url && result.number !== undefined && context) {
      await linkPrToThread(
        { url: result.url, owner: targetOwner, repo: targetRepo, number: result.number },
        context,
      )
    }
    return formatResult(result)
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
