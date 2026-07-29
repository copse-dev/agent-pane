import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Project } from '@shared/types/state.ts'
import type { Thread } from '@shared/types/thread.ts'
import type {
  PreparedThreadCheckout,
  ThreadCheckoutPreview,
  ThreadWorktree,
  ThreadWorktreeChoice,
} from '@shared/types/worktree.ts'
import { decideThreadWorktreePolicy } from '@shared/git/worktree-policy.ts'
import { isRemoteAgentModel } from '@shared/remote-agent.ts'
import { storageGet } from './storage/storage.ts'
import { runSerialized } from './storage/write-queue.ts'
import { getProjectThread, updateMetaOrThrow } from './thread-store.ts'
import { isRecord } from '@shared/unknown-value.ts'
import {
  allocateThreadWorktree,
  expectedThreadWorktreePath,
  listProjectWorktrees,
  retireThreadWorktree,
  validateThreadWorktree,
} from './worktree-manager.ts'
import {
  getCurrentBranchName,
  getDefaultBranch,
  getGitStatus,
  isInsideGitWorkTree,
  repositoryHasSubmodules,
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
  const [currentBranch, defaultBranch, status, hasSubmodules] = await Promise.all([
    getCurrentBranchName(project.path),
    getDefaultBranch(project.path),
    getGitStatus(project.path),
    repositoryHasSubmodules(project.path),
  ])
  return {
    isGitRepository: true,
    currentBranch,
    defaultBranch,
    isDirty: Boolean(status && (status.staged.length > 0 || status.unstaged.length > 0)),
    hasSubmodules,
  }
}

async function recoverUnpersistedWorktree(input: {
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
  return {
    path: canonicalPath,
    branch: existing.branch,
    baseBranch: input.baseBranch,
    baseCommit: existing.head,
    createdAt: Date.now(),
    // Conservative: a reclaim path is only needed when retirement was refused
    // (dirty seed / dirty worktree). Marking true preserves that retention.
    seededFromDirtyProject: true,
  }
}

const defaultDependencies: ThreadCheckoutTransactionDependencies = {
  getProject: projectById,
  getThread: getProjectThread,
  updateMeta: updateMetaOrThrow,
  inspect: inspectProject,
  allocate: allocateThreadWorktree,
  recoverUnpersisted: recoverUnpersistedWorktree,
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
    const isLocal = !project.sshHost && !(input.model && isRemoteAgentModel(input.model))
    const inspection = await dependencies.inspect(project, isLocal)
    const decision = decideThreadWorktreePolicy({
      choice: input.choice,
      projectMode: project.worktreeMode ?? 'never',
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
        projectMode: project.worktreeMode ?? 'never',
        isLocal,
        ...inspection,
      })

      if (decision.checkoutMode === 'blocked') {
        throw new Error(`Isolated worktree is unavailable: ${decision.reason.replaceAll('-', ' ')}`)
      }
      if (decision.checkoutMode === 'shared') {
        await dependencies.updateMeta(input.projectId, input.threadId, {
          worktreeChoice: input.choice,
          ...(inspection.currentBranch ? { gitBranch: inspection.currentBranch } : {}),
        })
        return persistedResult(input.choice, inspection.currentBranch ?? undefined)
      }

      if (!inspection.currentBranch)
        throw new Error('Cannot create a worktree from a detached HEAD')
      // A prior allocate may have succeeded while meta persistence failed. Prefer
      // reclaiming that registration over a second allocate that would throw
      // "already registered" and strand the thread.
      const recovered = await dependencies.recoverUnpersisted({
        projectId: input.projectId,
        threadId: input.threadId,
        projectRoot: project.path,
        baseBranch: inspection.currentBranch,
      })
      const worktree =
        recovered ??
        (await dependencies.allocate({
          projectId: input.projectId,
          threadId: input.threadId,
          projectRoot: project.path,
          prompt: input.prompt,
          baseBranch: inspection.currentBranch,
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
