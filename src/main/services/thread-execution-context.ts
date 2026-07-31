import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentHost } from '@copse/agent/agent-host.ts'
import type { StreamChunk } from '@shared/types'
import { classifyAgentError } from './agent-errors.ts'
import { getThreadMeta, updateMeta } from './thread-store.ts'
import { getProjectRoot } from './workspace.ts'
import { validateThreadWorktree, type ValidatedThreadWorktree } from './worktree-manager.ts'
import { startExecutionRootIndexing } from './search/workspace-indexing.ts'
import type { ThreadWorktree } from '@shared/types/worktree.ts'

async function syncAdoptedWorktreeBranch(
  projectId: string,
  threadId: string,
  worktree: ThreadWorktree,
): Promise<void> {
  await updateMeta(projectId, threadId, { worktree, gitBranch: worktree.branch })
}

export type ThreadCheckoutMode = 'shared' | 'worktree'

/** Trusted main-process identity and filesystem root for one agent turn. */
export interface ThreadExecutionContext {
  readonly projectId: string
  readonly threadId: string
  readonly projectRoot: string
  readonly root: string
  readonly checkoutMode: ThreadCheckoutMode
  readonly branch: string | null
}

export type ThreadExecutionOwner = Pick<ThreadExecutionContext, 'projectId' | 'threadId'>

export interface ThreadExecutionContextDependencies {
  getProjectRoot: (projectId: string) => string | null
  getThreadMeta: (
    projectId: string,
    threadId: string,
  ) => Promise<{
    readonly id: string
    readonly gitBranch?: string
    readonly worktree?: ThreadWorktree
  } | null>
  validateWorktree?: (input: {
    projectId: string
    threadId: string
    projectRoot: string
    worktree: ThreadWorktree
  }) => Promise<ValidatedThreadWorktree>
  /** Persist adopted live branch when Git HEAD drifted inside the worktree. */
  syncWorktreeBranch?: (
    projectId: string,
    threadId: string,
    worktree: ThreadWorktree,
  ) => Promise<void>
  /**
   * Register a resolved worktree's execution root with the file index and its
   * rebuild watcher (#1400) — fire-and-forget, never awaited, so a slow index
   * build never delays the turn it was resolved for.
   */
  startWorktreeIndexing?: (root: string) => void
}

const storage = new AsyncLocalStorage<ThreadExecutionContext>()

const defaultDependencies: ThreadExecutionContextDependencies = {
  getProjectRoot,
  getThreadMeta,
  validateWorktree: validateThreadWorktree,
  syncWorktreeBranch: syncAdoptedWorktreeBranch,
  startWorktreeIndexing: startExecutionRootIndexing,
}

/**
 * Resolve a shared or isolated context from trusted persisted state.
 * The renderer supplies identity, never a filesystem root; main validates both
 * the persisted project and the thread's membership before deriving that root.
 * Persisted worktree paths are diagnostic only: the manager reconstructs and
 * validates the registered checkout before its root can enter the run context.
 */
export async function resolveThreadExecutionContext(
  projectId: string,
  threadId: string,
  dependencies: ThreadExecutionContextDependencies = defaultDependencies,
): Promise<ThreadExecutionContext> {
  const projectRoot = dependencies.getProjectRoot(projectId)
  if (!projectRoot) throw new Error(`Cannot resolve root for project "${projectId}"`)

  const threadMeta = await dependencies.getThreadMeta(projectId, threadId)
  if (threadMeta?.id !== threadId) {
    throw new Error(`Thread "${threadId}" does not belong to project "${projectId}"`)
  }

  if (threadMeta.worktree) {
    const validate = dependencies.validateWorktree ?? validateThreadWorktree
    const worktree = await validate({
      projectId,
      threadId,
      projectRoot,
      worktree: threadMeta.worktree,
    })
    if (
      worktree.branch !== threadMeta.worktree.branch ||
      threadMeta.gitBranch !== worktree.branch
    ) {
      const adopted: ThreadWorktree = {
        path: threadMeta.worktree.path,
        branch: worktree.branch,
        baseBranch: threadMeta.worktree.baseBranch,
        baseCommit: threadMeta.worktree.baseCommit,
        createdAt: threadMeta.worktree.createdAt,
        seededFromDirtyProject: threadMeta.worktree.seededFromDirtyProject,
      }
      await dependencies.syncWorktreeBranch?.(projectId, threadId, adopted)
    }
    dependencies.startWorktreeIndexing?.(worktree.root)
    return Object.freeze({
      projectId,
      threadId,
      projectRoot,
      root: worktree.root,
      checkoutMode: 'worktree',
      branch: worktree.branch,
    })
  }

  return Object.freeze({
    projectId,
    threadId,
    projectRoot,
    root: projectRoot,
    checkoutMode: 'shared',
    branch: threadMeta.gitBranch ?? null,
  })
}

/**
 * Resolve a run's context without leaving the renderer stuck in `running` when
 * trusted identity setup fails before `runAgent` can emit its own terminal chunk.
 */
export async function prepareThreadExecutionContext(
  projectId: string,
  threadId: string,
  host: AgentHost<StreamChunk>,
  dependencies: ThreadExecutionContextDependencies = defaultDependencies,
): Promise<ThreadExecutionContext | null> {
  try {
    return await resolveThreadExecutionContext(projectId, threadId, dependencies)
  } catch (error) {
    host.emit(threadId, { type: 'text', text: classifyAgentError(error) })
    host.emit(threadId, { type: 'done' })
    return null
  }
}

/** Bind a context to the complete async lifetime of an agent turn. */
export function runWithThreadExecutionContext<T>(context: ThreadExecutionContext, fn: () => T): T {
  return storage.run(context, fn)
}

export function getThreadExecutionContext(): ThreadExecutionContext | null {
  return storage.getStore() ?? null
}

export function requireThreadExecutionContext(): ThreadExecutionContext {
  const context = storage.getStore()
  if (!context) throw new Error('No thread execution context is active')
  return context
}

/** Resolve the stable owner of run-scoped state without exposing its filesystem root. */
export function requireThreadExecutionOwner(): ThreadExecutionOwner {
  const { projectId, threadId } = requireThreadExecutionContext()
  return { projectId, threadId }
}
