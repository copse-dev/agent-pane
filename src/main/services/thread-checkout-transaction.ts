import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Project } from '@shared/types/state.ts'
import type { Thread } from '@shared/types/thread.ts'
import { DEFAULT_GIT_BRANCH } from '@shared/types/git.ts'
import type {
  PreparedThreadCheckout,
  ThreadCheckoutPreview,
  ThreadWorktree,
  ThreadWorktreeChoice,
} from '@shared/types/worktree.ts'
import { decideThreadWorktreePolicy, settledCheckoutMode } from '@shared/git/worktree-policy.ts'
import { isRemoteAgentModel } from '@shared/remote-agent.ts'
import { storageGet } from './storage/storage.ts'
import { runSerialized } from './storage/write-queue.ts'
import { getProjectThread, updateMetaOrThrow } from './thread-store.ts'
import { isRecord } from '@shared/unknown-value.ts'
import {
  allocateThreadWorktree,
  expectedThreadWorktreePath,
  listProjectWorktrees,
  readThreadWorktreeRecoveryMetadata,
  retireThreadWorktree,
  validateThreadWorktree,
} from './worktree-manager.ts'
import {
  getCurrentBranchName,
  getDefaultBranch,
  getGitStatus,
  isInsideGitWorkTree,
  localBranchExists,
  findSubmoduleDeclaration,
} from './github/git-service.ts'

export interface PrepareThreadCheckoutInput {
  projectId: string
  threadId: string
  prompt: string
  choice: ThreadWorktreeChoice
  model?: string
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
  hasSubmodules: boolean
  /** The `.gitmodules` behind `hasSubmodules`, surfaced when a checkout is refused. */
  submoduleDeclaration?: string | null
}

/**
 * The blank-thread branch picker speaks for the live local checkout, so its
 * selected branch is the worktree base — but only once the repository is known
 * to hold it. A remote default is the next useful choice, with `main` as the
 * conventional final fallback.
 *
 * The existence check is load-bearing rather than defensive. `currentBranch`
 * is a *reported* name, and a report is not a ref: the e2e suite replaces it
 * wholesale via `COPSE_PANEL_MOCK_BRANCH` so the branch chip stays stable, and
 * allocation rejects a base that resolves to nothing. Handing that name
 * straight to the allocator turns every isolated checkout into "Base branch
 * … does not exist in this repository" and strands the thread with no
 * transcript — which is exactly how the automation specs fail. In a real
 * checkout the name always resolves, so this costs one `show-ref` and changes
 * nothing.
 */
async function checkoutBaseBranch(
  branchExists: (branch: string) => Promise<boolean>,
  inspection: CheckoutInspection,
): Promise<string> {
  if (inspection.currentBranch && (await branchExists(inspection.currentBranch))) {
    return inspection.currentBranch
  }
  return inspection.defaultBranch ?? DEFAULT_GIT_BRANCH
}

export interface ThreadCheckoutTransactionDependencies {
  getProject: (projectId: string) => Project | null
  getThread: (projectId: string, threadId: string) => Promise<Thread | null>
  updateMeta: (
    projectId: string,
    threadId: string,
    patch: Partial<Omit<Thread, 'messages'>>,
  ) => Promise<void>
  inspect: (project: Project, isLocal: boolean) => Promise<CheckoutInspection>
  allocate: (input: {
    projectId: string
    threadId: string
    projectRoot: string
    prompt: string
    baseBranch: string
    seedFromDirtyProject: boolean
  }) => Promise<ThreadWorktree>
  /**
   * Reclaim a linked checkout left behind when allocate succeeded but
   * metadata persistence failed (especially dirty-seeded worktrees that
   * refuse retirement).
   */
  recoverUnpersisted: (input: {
    projectId: string
    threadId: string
    projectRoot: string
    baseBranch: string
  }) => Promise<ThreadWorktree | null>
  /** Whether the repository holds this branch, checked against its refs. */
  branchExists: (projectRoot: string, branch: string) => Promise<boolean>
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
): PreparedThreadCheckout {
  return { checkoutMode: 'shared', choice, branch: branch ?? null }
}

async function inspectProject(project: Project, isLocal: boolean): Promise<CheckoutInspection> {
  const isGitRepository = isLocal && (await isInsideGitWorkTree(project.path))
  if (!isGitRepository) {
    return {
      isGitRepository: false,
      currentBranch: null,
      defaultBranch: null,
      isDirty: false,
      hasSubmodules: false,
    }
  }
  const [currentBranch, defaultBranch, status] = await Promise.all([
    getCurrentBranchName(project.path),
    getDefaultBranch(project.path),
    getGitStatus(project.path),
  ])
  // The Linux sandbox used by read-only Git commands can briefly materialize
  // deny-path sentinels such as `.gitmodules`. Do not race the raw filesystem
  // probe against getGitStatus's sandbox lifecycle or a repository without
  // submodules can be rejected as if that transient guard were a declaration.
  const submoduleDeclaration = await findSubmoduleDeclaration(project.path)
  return {
    isGitRepository: true,
    currentBranch,
    defaultBranch,
    isDirty: Boolean(status && (status.staged.length > 0 || status.unstaged.length > 0)),
    hasSubmodules: submoduleDeclaration !== null,
    submoduleDeclaration,
  }
}

export async function recoverUnpersistedWorktree(input: {
  projectId: string
  threadId: string
  projectRoot: string
  baseBranch: string
}): Promise<ThreadWorktree | null> {
  const target = expectedThreadWorktreePath(input.projectId, input.threadId)
  const records = await listProjectWorktrees(input.projectRoot)
  const existing = records.find((record) => resolve(record.path) === resolve(target))
  if (!existing?.branch || !existing.head) return null
  const canonicalPath = await realpath(existing.path).catch(() => null)
  if (!canonicalPath) return null
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
  getProject: projectById,
  getThread: getProjectThread,
  updateMeta: updateMetaOrThrow,
  inspect: inspectProject,
  allocate: allocateThreadWorktree,
  recoverUnpersisted: recoverUnpersistedWorktree,
  branchExists: localBranchExists,
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
        return persistedResult(thread.worktreeChoice, thread.gitBranch)
      }

      // Old conversations predate checkout metadata and must keep their shared
      // behavior. Only a genuinely blank thread enters the first-message policy.
      if (thread.messages.length > 0) return persistedResult('shared', thread.gitBranch)

      const isLocal = !project.sshHost && !(input.model && isRemoteAgentModel(input.model))
      const inspection = await dependencies.inspect(project, isLocal)
      const decision = decideThreadWorktreePolicy({
        choice: input.choice,
        ...(project.worktreeMode ? { projectMode: project.worktreeMode } : {}),
        isLocal,
        ...inspection,
      })

      if (decision.checkoutMode === 'blocked') {
        // Name the evidence. `submodules unsupported` alone cannot be checked
        // against the filesystem afterwards, and an automation swallows this
        // error into a thread that simply never starts.
        const detail =
          decision.reason === 'submodules-unsupported' && inspection.submoduleDeclaration
            ? ` (${inspection.submoduleDeclaration}, for project ${project.path})`
            : ''
        throw new Error(
          `Isolated worktree is unavailable: ${decision.reason.replaceAll('-', ' ')}${detail}`,
        )
      }
      if (decision.checkoutMode === 'shared') {
        await dependencies.updateMeta(input.projectId, input.threadId, {
          worktreeChoice: input.choice,
          ...(inspection.currentBranch ? { gitBranch: inspection.currentBranch } : {}),
        })
        return persistedResult(input.choice, inspection.currentBranch ?? undefined)
      }

      // The footer picker changes the local checkout before first send, so its
      // current selection is authoritative. Allocation separately recognizes
      // when this is the repository default and then fetches/uses the latest
      // upstream tip instead of a stale local commit.
      const baseBranch = await checkoutBaseBranch(
        (branch) => dependencies.branchExists(project.path, branch),
        inspection,
      )
      // A prior allocate may have succeeded while meta persistence failed. Prefer
      // reclaiming that registration over a second allocate that would throw
      // "already registered" and strand the thread.
      const recovered = await dependencies.recoverUnpersisted({
        projectId: input.projectId,
        threadId: input.threadId,
        projectRoot: project.path,
        baseBranch,
      })
      const worktree =
        recovered ??
        (await dependencies.allocate({
          projectId: input.projectId,
          threadId: input.threadId,
          projectRoot: project.path,
          prompt: input.prompt,
          baseBranch,
          seedFromDirtyProject: decision.seededFromDirtyProject,
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
      }
    })
}

export const prepareThreadCheckout = createThreadCheckoutTransaction(defaultDependencies)
export const previewThreadCheckout = createThreadCheckoutPreview(defaultDependencies)
