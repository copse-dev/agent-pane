import { getCurrentBranchName, getDefaultBranch, getGithubRepoSlug } from './git-service.ts'
import { createPullRequest } from './gh-pr-actions-service.ts'
import { resolveGitHubBackend } from './backend/backend.ts'
import { appendPrBodyAttribution } from '@shared/git/commit-attribution.ts'
import { getThreadModels } from '../thread-models.ts'
import { recordThreadPrRefs } from '../thread-store.ts'
import { broadcastToAppWindows } from '../../windows/app-window-broadcast.ts'
import type { GithubPrRef } from '@shared/git/github-pr-url.ts'
import type { PrCreateRequest, PrCreateResult } from '@shared/types/git.ts'
import type { ThreadExecutionContext } from '../thread-execution-context.ts'

/**
 * The lookups this service steers by. Injectable (mirroring
 * {@link ThreadExecutionContextDependencies}) because the interesting property
 * is *which checkout* each one is asked about: a worktree thread reading the
 * shared tree's branch would open a PR from the wrong place, and that is not
 * observable from the outside once the real git calls are involved.
 */
export interface PrCreateDependencies {
  getGithubRepoSlug: (root: string | null | undefined) => Promise<string | null>
  getCurrentBranchName: (root: string | null | undefined) => Promise<string | null>
  getDefaultBranch: (root: string | null | undefined) => Promise<string | null>
  createPullRequest: typeof createPullRequest
  getThreadModels: (threadId: string) => string[]
  backendKind: () => PrCreateResult['backend']
  /**
   * Push a renderer event. Injected alongside the lookups because the pushes a
   * successful create makes are its only effect outside the returned result —
   * a test that cannot see them cannot tell the composer's door apart from one
   * that opens a PR and tells nobody.
   */
  broadcast: typeof broadcastToAppWindows
}

const defaultDependencies: PrCreateDependencies = {
  // The real helpers default their own root when handed undefined, which is
  // what "no thread context" should mean — so pass it straight through.
  getGithubRepoSlug: (root) => getGithubRepoSlug(root ?? undefined),
  getCurrentBranchName: (root) => getCurrentBranchName(root ?? undefined),
  getDefaultBranch: (root) => getDefaultBranch(root ?? undefined),
  createPullRequest,
  getThreadModels,
  backendKind: () => resolveGitHubBackend().kind,
  broadcast: broadcastToAppWindows,
}

/**
 * Open a pull request for a thread's checkout: resolve the target, append the
 * attribution trailer, create the PR, link it back to the thread and announce
 * it to the renderer.
 *
 * The single create path, shared by the `gh_pr_create` agent tool and the
 * "Create PR" composer chip's dialog. Both need the identical sequence — and in
 * particular both must do the two pieces of bookkeeping that are invisible
 * until they are missing: the `Co-Authored-By` trailer, and recording the PR
 * against the thread so the sidebar chip appears. Keeping one function means a
 * user-driven create cannot quietly drift from what the agent does.
 *
 * `context` supplies the checkout to read branches from (a worktree thread must
 * not inherit the shared tree's branch) and the thread to link the PR to. Null
 * falls back to the ambient execution root and skips linking, which is what a
 * tool call outside any thread already did.
 */
export async function createPrForThread(
  request: PrCreateRequest,
  context: ThreadExecutionContext | null,
  deps: PrCreateDependencies = defaultDependencies,
): Promise<PrCreateResult> {
  const root = context?.root
  const { owner, repo, head, base, draft } = request
  // A pre-flight rejection never reaches a backend, but `PrCreateResult` is the
  // one shape all four consumers read and it names which backend served the
  // call — so report the one that would have, rather than inventing a kind.
  const rejected = (message: string): PrCreateResult => ({
    ok: false,
    message,
    backend: deps.backendKind(),
  })

  // Half a target is never what the caller meant: splicing one explicit half
  // with the workspace slug's other half would silently aim at a mixed repo.
  if (!owner !== !repo) {
    return rejected('pass owner and repo together, or omit both to use the workspace repository.')
  }
  const workspaceSlug = await deps.getGithubRepoSlug(root)
  const [slugOwner, slugRepo] = workspaceSlug?.split('/') ?? []
  const targetOwner = owner ?? slugOwner
  const targetRepo = repo ?? slugRepo
  if (!targetOwner || !targetRepo) {
    return rejected(
      'could not resolve the repository. Pass owner and repo, or open a GitHub workspace.',
    )
  }

  // Branch defaults come from the local checkout, which only describes the
  // workspace repo. For an explicit different target, require both branches
  // rather than guessing from the wrong repository.
  const crossRepo = workspaceSlug !== `${targetOwner}/${targetRepo}`
  if (crossRepo && (!head || !base)) {
    return rejected(
      `${targetOwner}/${targetRepo} is not the workspace repository, so pass head and base explicitly — the local checkout cannot supply defaults for another repo.`,
    )
  }

  const headBranch = head ?? (await deps.getCurrentBranchName(root))
  if (!headBranch) {
    return rejected(
      'could not resolve the current branch. Pass head with the branch to open the PR from.',
    )
  }
  const baseBranch = base ?? (await deps.getDefaultBranch(root))
  if (!baseBranch) {
    return rejected(
      "could not resolve the repository's default branch. Pass base with the branch to merge into.",
    )
  }
  if (headBranch === baseBranch) {
    return rejected(
      `head and base are both ${headBranch}. Commit the work to its own branch first.`,
    )
  }

  const models = context ? deps.getThreadModels(context.threadId) : []
  const result = await deps.createPullRequest({
    owner: targetOwner,
    repo: targetRepo,
    head: headBranch,
    base: baseBranch,
    title: request.title,
    body: appendPrBodyAttribution(request.body ?? '', models),
    ...(draft === undefined ? {} : { draft }),
  })

  if (result.ok && result.url && result.number !== undefined && context) {
    const ref = { url: result.url, owner: targetOwner, repo: targetRepo, number: result.number }
    await linkPrToThread(ref, context, deps.broadcast)
    announcePrCreated(ref, context, deps.broadcast)
  }

  return result
}

/**
 * Link a freshly created (or rediscovered) PR to the thread that opened it, and
 * push the sidebar update so the chip appears without a relaunch. The ref is
 * built from the coordinates the backend returned — never re-parsed out of the
 * URL, which would silently drop GitHub Enterprise hosts. Best-effort: a PR
 * that opened successfully must not be reported as failed because bookkeeping
 * did not land.
 */
async function linkPrToThread(
  ref: GithubPrRef,
  context: Pick<ThreadExecutionContext, 'projectId' | 'threadId'>,
  broadcast: typeof broadcastToAppWindows,
): Promise<void> {
  try {
    const refs = await recordThreadPrRefs(context.projectId, context.threadId, [ref])
    if (!refs) return
    broadcast('threads:pr-refs', context.projectId, [{ threadId: context.threadId, prRefs: refs }])
  } catch (err) {
    console.warn('[pr-create] linking the PR to its thread failed:', err)
  }
}

/**
 * Tell the renderer a PR was just opened from this thread, so a pane showing
 * the changes that went into it can follow the work through to the PR view.
 *
 * Deliberately not folded into the `threads:pr-refs` push above: that channel
 * also carries the startup backfill, whose batches are indistinguishable from a
 * live creation once they arrive, and only a genuinely new PR may be allowed to
 * move a panel. Announced even when {@link linkPrToThread} failed — the PR pane
 * loads from these coordinates, not from the thread's recorded refs.
 *
 * Lives here, not in the `gh_pr_create` tool that first sent it (#2297), so
 * that the composer's "Create PR" dialog announces too: a panel that follows a
 * PR the agent opened but not one the user opened is the kind of split the
 * shared create path exists to prevent.
 */
function announcePrCreated(
  ref: GithubPrRef,
  context: Pick<ThreadExecutionContext, 'projectId' | 'threadId'>,
  broadcast: typeof broadcastToAppWindows,
): void {
  broadcast('threads:pr-created', context.projectId, context.threadId, ref)
}
