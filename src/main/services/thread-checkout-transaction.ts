import { realpath } from 'node:fs/promises'
import { withAutomationBudget } from './automations/automation-budget.ts'
import type { Project } from '@shared/types/state.ts'
import type { Thread } from '@shared/types/thread.ts'
import { DEFAULT_GIT_BRANCH } from '@shared/types/git.ts'
import type {
  PreparedThreadCheckout,
  ThreadCheckoutPreview,
  ThreadBaseFallback,
  ThreadDeferredWorktree,
  ThreadWorktree,
  ThreadWorktreeChoice,
} from '@shared/types/worktree.ts'
import { decideThreadWorktreePolicy, settledCheckoutMode } from '@shared/git/worktree-policy.ts'
import { isRemoteAgentModel } from '@shared/remote-agent.ts'
import { isAcpModel } from '@shared/acp.ts'
import { getSetting } from './storage/settings.ts'
import { acpModelCanDeferCheckout } from './acp/acp-deferred-checkout.ts'
import { preflightLocalAcpModel } from './acp/acp-command-preflight.ts'
import { storageGet } from './storage/storage.ts'
import { runSerialized } from './storage/write-queue.ts'
import { getProjectThread, updateMetaOrThrow } from './thread-store.ts'
import { getAutomationWorktreeReuse } from './automation-worktree-reuse.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { warmupLmStudioModel } from './providers/lm-studio-warmup.ts'
import {
  allocateThreadWorktree,
  defaultBranchResolves,
  expectedThreadWorktreePath,
  listProjectWorktrees,
  projectCheckoutBehindDefaultBranch,
  readThreadWorktreeRecoveryMetadata,
  renameThreadWorktreeBranch,
  restoreThreadWorktreeBranch,
  retireThreadWorktree,
  sameWorktreePath,
  validateThreadWorktree,
} from './worktree-manager.ts'
import {
  checkoutGitBranch,
  getCurrentBranchName,
  getDefaultBranch,
  getGitStatus,
  isInsideGitWorkTree,
  isRebaseInProgress,
  localBranchExists,
} from './github/git-service.ts'

/** Shown in the composer, which keeps the prompt for Retry. */
const SHARED_CHECKOUT_REBASING =
  'This checkout is in the middle of a rebase. Finish or abort it (git rebase --continue or --abort), then send again.'

export interface PrepareThreadCheckoutInput {
  projectId: string
  threadId: string
  prompt: string
  choice: ThreadWorktreeChoice
  model?: string
  /**
   * Branch the blank-thread footer picker selected to start from. The picker
   * only ever *names* it — nothing is checked out while the user is still
   * composing — so this transaction is where the selection takes effect: as the
   * base of the new worktree, or as a switch of the shared checkout.
   */
  baseBranch?: string
  /**
   * Where the worktree starts when `baseBranch` is absent. Defaults to
   * `default-branch`: only the desktop composer, which shows the project branch
   * in its picker whenever it cannot offer the default, asks for
   * `project-branch`. See {@link ThreadBaseFallback}.
   */
  baseFallback?: ThreadBaseFallback
}

export interface PreviewThreadCheckoutInput {
  projectId: string
  choice: ThreadWorktreeChoice
  model?: string
}

interface CheckoutInspection {
  isGitRepository: boolean
  currentBranch: string | null
  defaultBranch: string | null
  isDirty: boolean
}

/**
 * The worktree base for a thread's first message.
 *
 * An explicitly requested branch — the blank-thread picker's selection — wins,
 * but only once the repository is known to hold it. A picked branch that has
 * since been deleted fails the send outright, exactly as the shared path's
 * `git switch` would: the user named that branch on purpose, and quietly
 * cutting the worktree from somewhere else would start the thread where they
 * never asked.
 *
 * With nothing requested, `fallback` decides (see {@link ThreadBaseFallback}).
 * `default-branch` returns the repository default, which allocation recognizes
 * and cuts from `origin/<default>` after a best-effort fetch (a failed fetch
 * leaves the last fetched tip): a proposed, delegated or scheduled thread must
 * not inherit whatever branch the project checkout happens to be parked on.
 * `project-branch` keeps the composer's rule: the branch its picker displayed.
 * Either falls back to the other source. A repository that reports no default
 * at all (a fresh `git init` with no remote) then starts from `main`; one whose
 * reported default was refused fails the send and asks for a base, rather than
 * returning the name that was just rejected.
 *
 * Both sources are names, not refs, so each is checked before it is used.
 * `getDefaultBranch` reports whatever `refs/remotes/origin/HEAD` names even
 * when that symref dangles, as it does once origin renames its default and a
 * pruning fetch drops the tracking ref. Allocation would then cut from a stale
 * local branch of that name, or fail if there is none; `defaultBranchResolves`
 * refuses such a default. The check on `currentBranch` is just as
 * load-bearing: that is a *reported* name, and the e2e suite replaces it
 * wholesale via `COPSE_PANEL_MOCK_BRANCH`. Handing it straight to the
 * allocator would fail with "Base branch … does not exist in this repository"
 * and strand the thread with no transcript.
 */
async function checkoutBaseBranch(
  refs: {
    branchExists: (branch: string) => Promise<boolean>
    defaultBranchResolves: (branch: string) => Promise<boolean>
  },
  inspection: CheckoutInspection,
  requested: string | undefined,
  fallback: ThreadBaseFallback,
): Promise<string> {
  if (requested) {
    if (await refs.branchExists(requested)) return requested
    throw new Error(
      `Branch "${requested}" no longer exists in this repository. Pick another branch to start from.`,
    )
  }
  const reportedDefault = inspection.defaultBranch
  let defaultResolves: boolean | undefined
  const usableDefault = async (): Promise<string | null> => {
    if (!reportedDefault) return null
    defaultResolves ??= await refs.defaultBranchResolves(reportedDefault)
    return defaultResolves ? reportedDefault : null
  }
  if (fallback === 'default-branch') {
    const verified = await usableDefault()
    if (verified) return verified
  }
  // A thread that asked for the default must not get it back through the
  // checkout: a project parked on the stale local branch the dangling default
  // names would hand over the very base just refused. The composer's
  // `project-branch` keeps the checkout's branch, since that is what its picker
  // showed the user.
  const current = inspection.currentBranch
  const currentIsRefusedDefault = fallback === 'default-branch' && current === reportedDefault
  if (current && !currentIsRefusedDefault && (await refs.branchExists(current))) {
    return current
  }
  const verified = await usableDefault()
  if (verified) return verified
  if (!reportedDefault) return DEFAULT_GIT_BRANCH
  // The reported default was refused: its `origin/HEAD` dangles. Handing the
  // same name to the allocator anyway would cut the worktree from a stale
  // local branch of that name (or fail with no transcript), so stop and let the
  // user name the base instead.
  throw new Error(
    `The repository's default branch "${reportedDefault}" no longer exists on origin, so Copse can't tell where to start this thread. Pick a branch to start from, or run \`git remote set-head origin --auto\` in the project.`,
  )
}

export interface ThreadCheckoutTransactionDependencies {
  getDeferredWorktreesEnabled: () => boolean
  /** Whether this ACP model's agent can start read-only and move into a worktree later. */
  canDeferAcpModel: (model: string, options: { remote: boolean }) => boolean
  getProject: (projectId: string) => Project | null
  getThread: (projectId: string, threadId: string) => Promise<Thread | null>
  updateMeta: (
    projectId: string,
    threadId: string,
    patch: Partial<Omit<Thread, 'messages'>>,
  ) => Promise<void>
  /** Speculative model loading, started alongside first-message checkout setup. */
  warmupModel: (model?: string) => Promise<void>
  /** Cheap local prerequisite check before consuming a first prompt or changing its checkout. */
  preflightModel: (model: string | undefined, cwd: string) => Promise<void>
  inspect: (project: Project, isLocal: boolean) => Promise<CheckoutInspection>
  allocate: (input: {
    projectId: string
    threadId: string
    projectRoot: string
    prompt: string
    baseBranch: string
    seedFromDirtyProject: boolean
    /** Name the branch from this instead of the anonymous initial candidate. */
    branchTitle?: string
  }) => Promise<ThreadWorktree>
  /**
   * Reclaim a linked checkout left behind when allocate succeeded but
   * metadata persistence failed (especially dirty-seeded worktrees that
   * refuse retirement).
   */
  /**
   * Take over the previous run's finished checkout when `threadId` is an automation run and
   * that checkout can be handed on without carrying anything over. Null means allocate fresh.
   */
  reuseAutomationWorktree?: (input: {
    projectId: string
    threadId: string
    projectRoot: string
    baseBranch: string
  }) => Promise<ThreadWorktree | null>
  recoverUnpersisted: (input: {
    projectId: string
    threadId: string
    projectRoot: string
    baseBranch: string
  }) => Promise<ThreadWorktree | null>
  /**
   * Whether the project checkout lags the upstream tip of `branch`, after a
   * fresh fetch. A deferred thread reads the checkout, so a lagging one must
   * not be deferred. Absent means "never known to lag".
   */
  checkoutBehindDefaultBranch?: (projectRoot: string, branch: string) => Promise<boolean>
  /** Whether the repository holds this branch, checked against its refs. */
  branchExists: (projectRoot: string, branch: string) => Promise<boolean>
  /**
   * Whether the reported default branch still resolves to a commit a thread
   * can start from; false for one named only by a dangling `origin/HEAD`.
   */
  defaultBranchResolves: (projectRoot: string, branch: string) => Promise<boolean>
  /** Switch the shared checkout, for a shared thread that picked a branch. */
  checkoutBranch: (branch: string, projectRoot: string) => Promise<void>
  /** Whether a `git rebase` is stopped in the project checkout. */
  rebaseInProgress: (projectRoot: string) => Promise<boolean>
  validate: (input: {
    projectId: string
    threadId: string
    projectRoot: string
    worktree: ThreadWorktree
  }) => Promise<{ branch: string }>
  retire: (input: {
    projectId: string
    threadId: string
    projectRoot: string
    worktree: ThreadWorktree
  }) => Promise<unknown>
  serialize: <T>(key: string, task: () => Promise<T>) => Promise<T>
}

function projectById(projectId: string): Project | null {
  const projects = storageGet('projects')
  if (!Array.isArray(projects)) return null
  const project = projects.find((candidate): candidate is Project => {
    return (
      isRecord(candidate) && candidate['id'] === projectId && typeof candidate['path'] === 'string'
    )
  })
  return project ?? null
}

function persistedResult(
  choice: ThreadWorktreeChoice,
  branch: string | undefined,
  deferredWorktree?: ThreadDeferredWorktree,
): PreparedThreadCheckout {
  return {
    checkoutMode: 'shared',
    choice,
    branch: branch ?? null,
    ...(deferredWorktree ? { deferredWorktree } : {}),
  }
}

/**
 * Whether this run's agent can honour a deferred checkout. A native model
 * relies on Copse's own tool registry to allocate before the first write. An
 * ACP agent edits through its own process whose cwd is fixed at session
 * creation, so it defers only when it can be started read-only and restarted
 * in the worktree (`canDeferAcpModel`); otherwise it keeps the eager worktree.
 * An unknown model is treated the same way.
 */
function canDeferAllocation(
  model: string | undefined,
  canDeferAcpModel: ThreadCheckoutTransactionDependencies['canDeferAcpModel'],
  isLocal: boolean,
): boolean {
  if (model === undefined) return false
  if (!isAcpModel(model)) return true
  // A remote agent never sees the local sandbox that makes a read-only start safe.
  return isLocal && canDeferAcpModel(model, { remote: false })
}

export async function inspectProject(
  project: Project,
  isLocal: boolean,
): Promise<CheckoutInspection> {
  const isGitRepository = isLocal && (await isInsideGitWorkTree(project.path))
  if (!isGitRepository) {
    return {
      isGitRepository: false,
      currentBranch: null,
      defaultBranch: null,
      isDirty: false,
    }
  }
  const [currentBranch, defaultBranch, status] = await Promise.all([
    getCurrentBranchName(project.path),
    getDefaultBranch(project.path),
    getGitStatus(project.path),
  ])
  return {
    isGitRepository: true,
    currentBranch,
    defaultBranch,
    isDirty: Boolean(status && (status.staged.length > 0 || status.unstaged.length > 0)),
  }
}

export async function recoverUnpersistedWorktree(input: {
  projectId: string
  threadId: string
  projectRoot: string
  baseBranch: string
}): Promise<ThreadWorktree | null> {
  const target = expectedThreadWorktreePath(input.projectId, input.threadId)
  // A normal first submit has never created this path, so there cannot be a
  // checkout to reclaim. Prove that locally before paying for repository-root
  // resolution plus `git worktree list`; allocation still performs Git's
  // authoritative registration check, including for missing/prunable records.
  const canonicalPath = await realpath(target).catch((error: unknown) => {
    if (isRecord(error)) {
      const code = error['code']
      if (code === 'ENOENT' || code === 'ENOTDIR') return null
    }
    throw error
  })
  if (!canonicalPath) return null
  const records = await listProjectWorktrees(input.projectRoot)
  const existing = records.find((record) => sameWorktreePath(record.path, target))
  if (!existing?.branch || !existing.head) return null
  // The recovery marker sharpens the reclaim — it carries the original base and
  // whether the checkout was dirty-seeded — but it cannot gate it. Git has
  // already registered this linked checkout, so returning null here does not
  // fall back to a clean allocation: it falls through to `allocate`, which
  // throws "already registered" and strands the thread. Any checkout cut before
  // the marker existed, or by a path that failed between `worktree add` and the
  // config write, has no marker and must still be reclaimable.
  //
  // Without it, reconstruct the conservative shape the reclaim used before the
  // marker: the caller's base, the branch's current head, and dirty-seeded so
  // retirement keeps refusing to discard state this process never observed.
  const metadata = await readThreadWorktreeRecoveryMetadata(input.projectRoot, existing.branch)
  return {
    path: canonicalPath,
    branch: existing.branch,
    ...(metadata ?? {
      baseBranch: input.baseBranch,
      baseCommit: existing.head,
      createdAt: Date.now(),
      seededFromDirtyProject: true,
    }),
  }
}

const defaultDependencies: ThreadCheckoutTransactionDependencies = {
  getDeferredWorktreesEnabled: () => getSetting<boolean>('deferredWorktreesEnabled', false),
  canDeferAcpModel: acpModelCanDeferCheckout,
  getProject: projectById,
  getThread: getProjectThread,
  updateMeta: updateMetaOrThrow,
  warmupModel: warmupLmStudioModel,
  preflightModel: preflightLocalAcpModel,
  inspect: inspectProject,
  allocate: allocateThreadWorktree,
  reuseAutomationWorktree: (input) => getAutomationWorktreeReuse().reuseFor(input),
  recoverUnpersisted: recoverUnpersistedWorktree,
  checkoutBehindDefaultBranch: projectCheckoutBehindDefaultBranch,
  branchExists: localBranchExists,
  defaultBranchResolves,
  checkoutBranch: checkoutGitBranch,
  rebaseInProgress: isRebaseInProgress,
  validate: validateThreadWorktree,
  retire: retireThreadWorktree,
  serialize: runSerialized,
}

export function createThreadCheckoutPreview(
  dependencies: Pick<ThreadCheckoutTransactionDependencies, 'getProject' | 'inspect'>,
): (input: PreviewThreadCheckoutInput) => Promise<ThreadCheckoutPreview> {
  return async (input) => {
    const project = dependencies.getProject(input.projectId)
    if (!project) return { checkoutMode: 'shared' }
    // Avoid four Git queries when the choice or explicit project setting
    // already determines the preview. An absent project mode deliberately uses
    // the policy's `always` default and still inspects repository support.
    const settled = settledCheckoutMode({
      choice: input.choice,
      ...(project.worktreeMode ? { projectMode: project.worktreeMode } : {}),
    })
    if (settled) return { checkoutMode: settled }
    const isLocal = !project.sshHost && !(input.model && isRemoteAgentModel(input.model))
    const inspection = await dependencies.inspect(project, isLocal)
    const decision = decideThreadWorktreePolicy({
      choice: input.choice,
      ...(project.worktreeMode ? { projectMode: project.worktreeMode } : {}),
      isLocal,
      ...inspection,
    })
    return { checkoutMode: decision.checkoutMode }
  }
}

/**
 * Atomically decide, allocate, and persist a blank thread's checkout before its
 * first user message is recorded or dispatched. Re-entry is idempotent.
 */
export function createThreadCheckoutTransaction(
  dependencies: ThreadCheckoutTransactionDependencies,
): (input: PrepareThreadCheckoutInput) => Promise<PreparedThreadCheckout> {
  return (input) =>
    dependencies.serialize(`thread-checkout:${input.projectId}:${input.threadId}`, async () => {
      const project = dependencies.getProject(input.projectId)
      if (!project) throw new Error('Project is no longer available')
      const thread = await dependencies.getThread(input.projectId, input.threadId)
      if (!thread) throw new Error('Thread is not persisted yet; retry sending the message')

      if (thread.worktree) {
        const validated = await dependencies.validate({
          projectId: input.projectId,
          threadId: input.threadId,
          projectRoot: project.path,
          worktree: thread.worktree,
        })
        const worktree: ThreadWorktree = {
          ...thread.worktree,
          branch: validated.branch,
        }
        if (worktree.branch !== thread.worktree.branch || thread.gitBranch !== worktree.branch) {
          await dependencies.updateMeta(input.projectId, input.threadId, {
            worktree,
            gitBranch: worktree.branch,
          })
        }
        return {
          checkoutMode: 'worktree',
          choice: thread.worktreeChoice ?? 'worktree',
          branch: worktree.branch,
          worktree,
        }
      }
      if (thread.worktreeChoice) {
        return persistedResult(thread.worktreeChoice, thread.gitBranch, thread.deferredWorktree)
      }

      // Old conversations predate checkout metadata and must keep their shared
      // behavior. Only a genuinely blank thread enters the first-message policy.
      if (thread.messages.length > 0) return persistedResult('shared', thread.gitBranch)

      // SSH agents run on the other machine. Never diagnose their installation
      // from this device, and never start an authentication/model probe here.
      if (!project.sshHost) {
        await dependencies.preflightModel(input.model ?? thread.model, project.path)
      }

      // Loading a local model can overlap every Git probe and the allocation.
      // Do not await it: unavailable/older model servers must not delay checkout.
      void dependencies.warmupModel(input.model ?? thread.model).catch(() => undefined)

      const isLocal = !project.sshHost && !(input.model && isRemoteAgentModel(input.model))
      const inspection = await dependencies.inspect(project, isLocal)
      const decision = decideThreadWorktreePolicy({
        deferredWorktreesEnabled: dependencies.getDeferredWorktreesEnabled(),
        choice: input.choice,
        ...(project.worktreeMode ? { projectMode: project.worktreeMode } : {}),
        isLocal,
        ...inspection,
      })

      if (decision.checkoutMode === 'blocked') {
        throw new Error(`Isolated worktree is unavailable: ${decision.reason.replaceAll('-', ' ')}`)
      }
      if (decision.checkoutMode === 'shared') {
        // A shared thread runs in the project checkout itself, so a picked
        // branch has to become the checked-out one — and this is the first
        // moment it may: the picker deliberately did not touch the working tree
        // while the user was still composing. Failing here (a dirty tree, or a
        // branch another worktree holds) leaves the prompt in the composer with
        // its own retry, which is why the switch precedes any persistence.
        // Not for a shared mode the repository never had a say in: a remote
        // agent, or an SSH/non-Git project, has no local branch to switch even
        // though the footer picker was on screen when the user chose one.
        const switched =
          inspection.isGitRepository &&
          input.baseBranch &&
          inspection.currentBranch !== input.baseBranch
            ? input.baseBranch
            : null
        // A stopped rebase leaves the checkout on no branch. Starting there
        // would put the agent's commits into the branch being rewritten at
        // `git rebase --continue`, and Git refuses a switch anyway. Keep the
        // prompt in the composer until the user finishes or aborts it.
        if (
          inspection.isGitRepository &&
          inspection.currentBranch === null &&
          (await dependencies.rebaseInProgress(project.path))
        ) {
          throw new Error(SHARED_CHECKOUT_REBASING)
        }
        if (switched) await dependencies.checkoutBranch(switched, project.path)
        const branch = switched ?? inspection.currentBranch
        try {
          await dependencies.updateMeta(input.projectId, input.threadId, {
            worktreeChoice: input.choice,
            ...(branch ? { gitBranch: branch } : {}),
          })
        } catch (error) {
          // The message never sent, so the checkout must not stay moved for it:
          // the user would find their project on a branch they picked for a
          // thread that does not exist. Best effort — the original failure is
          // the one worth surfacing, and Retry re-runs the switch anyway.
          const previous = inspection.currentBranch
          if (switched && previous) {
            await dependencies
              .checkoutBranch(previous, project.path)
              .catch((restoreError: unknown) => {
                console.warn(
                  `[thread-checkout] Could not switch back to "${previous}" after persistence failed:`,
                  restoreError,
                )
              })
          }
          throw error
        }
        return persistedResult(input.choice, branch ?? undefined)
      }

      // Allocation separately recognizes when the base is the repository
      // default and then fetches/uses the latest upstream tip instead of a
      // stale local commit.
      const baseBranch = await checkoutBaseBranch(
        {
          branchExists: (branch) => dependencies.branchExists(project.path, branch),
          defaultBranchResolves: (branch) =>
            dependencies.defaultBranchResolves(project.path, branch),
        },
        inspection,
        input.baseBranch,
        input.baseFallback ?? 'default-branch',
      )
      // A deferred thread reads the project checkout until its first write, and
      // only allocation fetches the upstream default. Defer only when that read
      // is current; otherwise allocate now, which cuts from the fetched tip.
      const deferrable =
        decision.deferAllocation &&
        canDeferAllocation(input.model, dependencies.canDeferAcpModel, isLocal) &&
        !(
          dependencies.checkoutBehindDefaultBranch &&
          baseBranch === inspection.defaultBranch &&
          (await dependencies.checkoutBehindDefaultBranch(project.path, baseBranch))
        )
      if (deferrable) {
        // Isolation is decided now; only the checkout waits. The base is
        // resolved (and a picked branch validated) here so the eventual
        // allocation starts where the user asked even if the project checkout
        // moves in between. The project checkout is not switched: a deferred
        // thread reads it as-is and never writes to it.
        const deferredWorktree: ThreadDeferredWorktree = { baseBranch, requestedAt: Date.now() }
        const branch = inspection.currentBranch
        await dependencies.updateMeta(input.projectId, input.threadId, {
          worktreeChoice: input.choice,
          deferredWorktree,
          ...(branch ? { gitBranch: branch } : {}),
        })
        return persistedResult(input.choice, branch ?? undefined, deferredWorktree)
      }
      // A prior allocate may have succeeded while meta persistence failed. Prefer
      // reclaiming that registration over a second allocate that would throw
      // "already registered" and strand the thread.
      const recovered = await dependencies.recoverUnpersisted({
        projectId: input.projectId,
        threadId: input.threadId,
        projectRoot: project.path,
        baseBranch,
      })
      // Reuse comes after recovery: a half-finished hand-over already sits at this thread's
      // path, and recovery is what reclaims it. Any failure to reuse falls back to allocation.
      const reused =
        recovered === null && dependencies.reuseAutomationWorktree
          ? await dependencies.reuseAutomationWorktree({
              projectId: input.projectId,
              threadId: input.threadId,
              projectRoot: project.path,
              baseBranch,
            })
          : null
      const worktree =
        recovered ??
        reused ??
        (await dependencies.allocate({
          projectId: input.projectId,
          threadId: input.threadId,
          projectRoot: project.path,
          prompt: input.prompt,
          baseBranch,
          seedFromDirtyProject: decision.seededFromDirtyProject,
        }))
      if (recovered ?? reused) {
        await dependencies.validate({
          projectId: input.projectId,
          threadId: input.threadId,
          projectRoot: project.path,
          worktree,
        })
      }
      try {
        await dependencies.updateMeta(input.projectId, input.threadId, {
          worktreeChoice: input.choice,
          worktree,
          gitBranch: worktree.branch,
        })
      } catch (error) {
        // A pristine just-created checkout is safe to retire. Dirty seeded state
        // (and any reclaim candidate) is deliberately retained for the next retry.
        if (!worktree.seededFromDirtyProject) {
          await dependencies
            .retire({
              projectId: input.projectId,
              threadId: input.threadId,
              projectRoot: project.path,
              worktree,
            })
            .catch(() => undefined)
        }
        throw error
      }
      return {
        checkoutMode: 'worktree',
        choice: input.choice,
        branch: worktree.branch,
        worktree,
        // Allocation just created HEAD at baseCommit and is the only code that
        // can seed edits before returning. Recovered worktrees may have changed
        // since their failed first attempt, so those deliberately fall back to
        // a live prompt-state read in the renderer.
        ...(recovered
          ? {}
          : {
              promptState: {
                startingCommit: worktree.baseCommit,
                dirty: worktree.seededFromDirtyProject,
              },
            }),
      }
    })
}

export interface AllocateDeferredWorktreeInput {
  projectId: string
  threadId: string
  /** Agent-supplied description of the change, used to name the branch. */
  branchTitle?: string
}

/**
 * Allocate the worktree a deferred (`on-write`) thread postponed at its first
 * message. Serialized with the first-message transaction on the same key, and
 * idempotent: parallel tool calls in one turn share a single allocation, and a
 * thread that already owns a worktree just returns it.
 *
 * Never seeds from the project checkout's uncommitted work: the worktree
 * always starts clean, matching the first-message allocation path.
 */
export function createDeferredWorktreeAllocation(
  dependencies: ThreadCheckoutTransactionDependencies,
): (input: AllocateDeferredWorktreeInput) => Promise<PreparedThreadCheckout> {
  return (input) =>
    dependencies.serialize(`thread-checkout:${input.projectId}:${input.threadId}`, async () => {
      const project = dependencies.getProject(input.projectId)
      if (!project) throw new Error('Project is no longer available')
      const thread = await dependencies.getThread(input.projectId, input.threadId)
      if (!thread) throw new Error('Thread is no longer available')
      const choice = thread.worktreeChoice ?? 'automatic'
      if (thread.worktree) {
        const validated = await dependencies.validate({
          projectId: input.projectId,
          threadId: input.threadId,
          projectRoot: project.path,
          worktree: thread.worktree,
        })
        return {
          checkoutMode: 'worktree',
          choice,
          branch: validated.branch,
          worktree: { ...thread.worktree, branch: validated.branch },
        }
      }
      const deferred = thread.deferredWorktree
      if (!deferred) throw new Error('This thread did not defer its worktree')

      const recovered = await dependencies.recoverUnpersisted({
        projectId: input.projectId,
        threadId: input.threadId,
        projectRoot: project.path,
        baseBranch: deferred.baseBranch,
      })
      const worktree =
        recovered ??
        (await dependencies.allocate({
          projectId: input.projectId,
          threadId: input.threadId,
          projectRoot: project.path,
          prompt: '',
          baseBranch: deferred.baseBranch,
          seedFromDirtyProject: false,
          ...(input.branchTitle ? { branchTitle: input.branchTitle } : {}),
        }))
      if (recovered) {
        await dependencies.validate({
          projectId: input.projectId,
          threadId: input.threadId,
          projectRoot: project.path,
          worktree,
        })
      }
      try {
        await dependencies.updateMeta(input.projectId, input.threadId, {
          worktree,
          gitBranch: worktree.branch,
        })
      } catch (error) {
        if (!worktree.seededFromDirtyProject) {
          await dependencies
            .retire({
              projectId: input.projectId,
              threadId: input.threadId,
              projectRoot: project.path,
              worktree,
            })
            .catch(() => undefined)
        }
        throw error
      }
      return {
        checkoutMode: 'worktree',
        choice,
        branch: worktree.branch,
        worktree,
        deferredWorktree: deferred,
      }
    })
}

export interface ThreadWorktreeBranchRenameDependencies {
  getProject: (projectId: string) => Project | null
  getThread: (projectId: string, threadId: string) => Promise<Thread | null>
  updateMeta: (
    projectId: string,
    threadId: string,
    patch: Partial<Omit<Thread, 'messages'>>,
  ) => Promise<void>
  rename: (input: {
    projectId: string
    threadId: string
    projectRoot: string
    title: string
    worktree: ThreadWorktree
  }) => Promise<ThreadWorktree | null>
  restore: (
    input: {
      projectId: string
      threadId: string
      projectRoot: string
      worktree: ThreadWorktree
    },
    branch: string,
  ) => Promise<ThreadWorktree>
}

/** Rename the allocator-owned initial branch and keep durable thread metadata in step. */
export function createThreadWorktreeBranchRename(
  dependencies: ThreadWorktreeBranchRenameDependencies,
): (projectId: string, threadId: string, title: string) => Promise<ThreadWorktree | null> {
  return async (projectId, threadId, title) => {
    const project = dependencies.getProject(projectId)
    if (!project) return null
    const thread = await dependencies.getThread(projectId, threadId)
    if (!thread?.worktree) return null
    const previous = thread.worktree
    const renamed = await dependencies.rename({
      projectId,
      threadId,
      projectRoot: project.path,
      title,
      worktree: previous,
    })
    if (!renamed) return null
    try {
      await dependencies.updateMeta(projectId, threadId, {
        worktree: renamed,
        gitBranch: renamed.branch,
      })
    } catch (error) {
      await dependencies
        .restore(
          {
            projectId,
            threadId,
            projectRoot: project.path,
            worktree: renamed,
          },
          previous.branch,
        )
        .catch((restoreError: unknown) => {
          console.error(
            '[thread-checkout] Could not restore branch after persistence failed:',
            restoreError,
          )
        })
      throw error
    }
    return renamed
  }
}

const defaultBranchRenameDependencies: ThreadWorktreeBranchRenameDependencies = {
  getProject: projectById,
  getThread: getProjectThread,
  updateMeta: updateMetaOrThrow,
  rename: renameThreadWorktreeBranch,
  restore: restoreThreadWorktreeBranch,
}

const prepareCheckout = createThreadCheckoutTransaction(defaultDependencies)
export const prepareThreadCheckout = (
  input: PrepareThreadCheckoutInput,
): Promise<PreparedThreadCheckout> =>
  withAutomationBudget(input.projectId, input.threadId, () => prepareCheckout(input))
export const previewThreadCheckout = createThreadCheckoutPreview(defaultDependencies)
export const allocateDeferredThreadWorktree = createDeferredWorktreeAllocation(defaultDependencies)
export const renameThreadWorktreeBranchAfterTitle = createThreadWorktreeBranchRename(
  defaultBranchRenameDependencies,
)
