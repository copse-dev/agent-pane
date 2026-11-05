import { z } from 'zod'
import { defineTool } from '@shared/types'
import {
  getGithubRepoSlug,
  getCurrentBranchName,
  pushBranchToOrigin,
  unsignedCommitsToPublish,
} from '../services/github/git-service.ts'
import { getAgentExecutionRoot } from '../services/execution-root.ts'
import { createPrMaintenanceService } from '../services/github/pr-maintenance-service.ts'
import { runGh } from '../services/github/gh-service.ts'
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

/** Fill missing owner/repo halves from the origin slug of the turn's checkout (`root`). */
async function resolveOwnerRepo(
  root: string | null,
  owner: string | undefined,
  repo: string | undefined,
): Promise<{ owner: string; repo: string } | null> {
  if (!owner || !repo) {
    const slug = await getGithubRepoSlug(root)
    const [slugOwner, slugRepo] = slug?.split('/') ?? []
    owner = owner ?? slugOwner
    repo = repo ?? slugRepo
  }
  if (!owner || !repo) return null
  return { owner, repo }
}

/** Resolve owner/repo from args, falling back to the workspace origin slug. */
async function resolveRef(
  root: string | null,
  args: {
    number: number
    owner?: string | undefined
    repo?: string | undefined
  },
): Promise<PrRef | null> {
  const target = await resolveOwnerRepo(root, args.owner, args.repo)
  return target ? { ...target, number: args.number } : null
}

function formatResult(result: Pick<PrActionResult, 'ok' | 'message' | 'noop'>): string {
  const prefix = result.ok ? (result.noop ? 'No change' : 'Done') : 'Failed'
  return `${prefix}: ${result.message}`
}

async function runAction(
  args: { number: number; owner?: string | undefined; repo?: string | undefined },
  action: (root: string | null, ref: PrRef) => Promise<PrActionResult>,
): Promise<string> {
  // The turn's own checkout, never the window's workspace (#3958).
  const root = getAgentExecutionRoot()
  const ref = await resolveRef(root, args)
  if (!ref) {
    return 'Failed: could not resolve the repository. Pass owner and repo, or open a GitHub workspace.'
  }
  return formatResult(await action(root, ref))
}

export const ghPushTool = defineTool({
  name: 'gh_push',
  description:
    'Push the current thread branch to origin, updating its existing pull request. Does not force push or create a PR. Mutating action — asks for approval.',
  parameters: z.object({}).strict(),
  execute: async () => {
    const context = getThreadExecutionContext()
    if (!context) return 'Failed: no thread checkout is available.'
    const branch = await getCurrentBranchName(context.root)
    if (!branch || (context.branch && context.branch !== branch))
      return 'Failed: the thread branch is detached or has changed. Refresh the checkout before pushing.'
    return formatResult(await pushBranchToOrigin(branch, context.root))
  },
})

export const ghCreatePrTool = defineTool({
  name: 'gh_pr_create',
  description:
    'Push the current branch and open a pull request for it. When Git attribution is enabled in Settings (the default), Copse appends its attribution trailer. Copse links the PR to this thread (the sidebar PR chip) from the created PR itself. An explicit head is assumed to be pushed already. Mutating action — asks for approval.',
  parameters: z.object({
    title: z.string().min(1).describe('Pull request title.'),
    body: z
      .string()
      .optional()
      .default('')
      .describe(
        'Pull request body in markdown. Copse attribution follows the Git attribution setting.',
      ),
    base: z
      .string()
      .optional()
      .describe("Branch to merge into. Omit to use the repository's default branch."),
    head: z
      .string()
      .optional()
      .describe(
        'Branch holding the changes. Omit to push and use the current branch. An explicit branch must already be pushed.',
      ),
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

const commitSha = z.string().regex(/^[a-f0-9]{40}$/i)
// Bound per call to the running turn's checkout, never the window's (#3958).
const maintenance = createPrMaintenanceService((args) =>
  runGh(args, { cwd: getAgentExecutionRoot() }),
)

export const gitPushTool = defineTool({
  name: 'git_push',
  description:
    'Push one local branch to the same branch on origin. Requires approval or an exact automation grant. When the checkout requires signed commits, refuses to publish unsigned ones. For rebased history, supply the previously observed remote commit SHA; Copse uses a pinned force-with-lease. Never uses bare force.',
  parameters: z.object({
    branch: z.string().min(1).describe('Existing local branch to publish to origin.'),
    expected_remote_sha: commitSha
      .optional()
      .describe(
        'Previously observed remote head. Required to replace rewritten history; omit for a normal fast-forward push.',
      ),
  }),
  execute: async ({ branch, expected_remote_sha }) => {
    const root = getAgentExecutionRoot()
    if (!root) return 'Failed: No workspace open.'
    // Unattended runs must not publish work the checkout's signing policy rejects.
    const unsigned = await unsignedCommitsToPublish(root, branch)
    if (unsigned === null) return `Failed: could not list the commits ${branch} would publish.`
    if (unsigned.length > 0) {
      return `Failed: this checkout requires signed commits, and ${String(unsigned.length)} commit(s) to publish are unsigned (${unsigned.map((sha) => sha.slice(0, 9)).join(', ')}). Re-create them with signing before pushing.`
    }
    const outcome = await pushBranchToOrigin(branch, root, expected_remote_sha)
    return `${outcome.ok ? 'Done' : 'Failed'}: ${outcome.message}`
  },
})

export const ghMergePrTool = defineTool({
  name: 'gh_pr_merge',
  description:
    'Request a pull request merge with the GitHub CLI, using repository merge policy and a required head-SHA guard. Refuses drafts, outstanding change requests, and PRs without an approving review of the current head commit. Does not bypass branch protection. Review checks, feedback, holds in the description, and visual evidence first; re-read PR state afterward to distinguish merged from queued.',
  parameters: prActionParams.extend({ expected_head_sha: commitSha }),
  execute: async (args) => {
    const ref = await resolveRef(getAgentExecutionRoot(), args)
    return ref
      ? maintenance.merge(ref, args.expected_head_sha)
      : 'Failed: could not resolve repository.'
  },
})

export const ghCommentPrTool = defineTool({
  name: 'gh_pr_comment',
  description:
    'Post a markdown comment on a pull request using the GitHub CLI. Requires approval or an exact automation grant.',
  parameters: prActionParams.extend({ body: z.string().min(1).max(65536) }),
  execute: async (args) => {
    const ref = await resolveRef(getAgentExecutionRoot(), args)
    return ref ? maintenance.comment(ref, args.body) : 'Failed: could not resolve repository.'
  },
})

export const ghResolveReviewThreadTool = defineTool({
  name: 'gh_pr_resolve_review_thread',
  description:
    'Resolve a verified stale review thread using the GitHub CLI. Verifies the thread belongs to the specified repository and PR. Inspect the finding and confirm the fix before calling.',
  parameters: prActionParams.extend({ thread_id: z.string().min(1).max(512) }),
  execute: async (args) => {
    const ref = await resolveRef(getAgentExecutionRoot(), args)
    return ref
      ? maintenance.resolveReviewThread(ref, args.thread_id)
      : 'Failed: could not resolve repository.'
  },
})

/**
 * All PR lifecycle write tools. `ToolDefinition<TArgs>` is invariant in TArgs,
 * so the heterogeneous list is only usable where names suffice (unregister);
 * registration goes through {@link registerGhPrActionTools} so both lists live
 * in this file and are edited together.
 */
export const ghPrActionTools = [
  ghPushTool,
  ghCreatePrTool,
  ghRerunFailedCiTool,
  ghApprovePrTool,
  ghMarkPrReadyTool,
  ghEnableAutoMergeTool,
  gitPushTool,
  ghMergePrTool,
  ghCommentPrTool,
  ghResolveReviewThreadTool,
]

/** These actions currently require the host CLI, rather than the token-only backend. */
export const ghCliMaintenanceTools = [ghMergePrTool, ghCommentPrTool, ghResolveReviewThreadTool]

/** Register every PR lifecycle write tool (idempotent — register overwrites). */
export function registerGhPrActionTools(registry: ToolRegistry): void {
  registry.register(ghPushTool)
  registry.register(ghCreatePrTool)
  registry.register(ghRerunFailedCiTool)
  registry.register(ghApprovePrTool)
  registry.register(ghMarkPrReadyTool)
  registry.register(ghEnableAutoMergeTool)
  registry.register(gitPushTool)
  registry.register(ghMergePrTool)
  registry.register(ghCommentPrTool)
  registry.register(ghResolveReviewThreadTool)
}
