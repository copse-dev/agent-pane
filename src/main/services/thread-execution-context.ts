import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentHost } from '@copse/agent/agent-host.ts'
import type { StreamChunk } from '@shared/types'
import { classifyAgentError } from './agent-errors.ts'
import { getThreadMeta, updateMeta } from './thread-store.ts'
import { getProjectRoot } from './workspace.ts'
import {
  restoreRetiredThreadWorktree,
  validateThreadWorktree,
  type ValidatedThreadWorktree,
} from './worktree-manager.ts'
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
  restoreWorktree?: (input: {
    projectId: string
    threadId: string
    projectRoot: string
    worktree: ThreadWorktree
  }) => Promise<ThreadWorktree>
  /** Persist adopted live branch when Git HEAD drifted inside the worktree. */
  syncWorktreeBranch?: (
    projectId: string,
    threadId: string,
    worktree: ThreadWorktree,
  ) => Promise<void>
  /**
   * Register an agent turn's resolved worktree root with the file index and its
   * rebuild watcher (#1400). Generic context resolution deliberately does not
   * call this: renderer file/Git IPCs only need the validated root, and selecting
   * a thread must not start a full checkout listing as a side effect (#1728).
   */
  startWorktreeIndexing?: (root: string) => void
}

const storage = new AsyncLocalStorage<ThreadExecutionContext>()

const defaultDependencies: ThreadExecutionContextDependencies = {
  getProjectRoot,
  getThreadMeta,
  validateWorktree: validateThreadWorktree,
  restoreWorktree: restoreRetiredThreadWorktree,
  syncWorktreeBranch: syncAdoptedWorktreeBranch,
  startWorktreeIndexing: startExecutionRootIndexing,
}

// Selecting one thread fans out into several independent renderer IPCs (branch
// status, changes, file links, etc.). They all need the same trusted root, and a
// worktree resolution runs multiple Git commands to validate that root. Share
// only concurrent resolutions: once a flight settles it is removed, so the next
// request still observes branch changes, retirement, or a replaced worktree.
const resolutionFlights = new WeakMap<
  ThreadExecutionContextDependencies,
  Map<string, Promise<ThreadExecutionContext>>
>()

function executionOwnerKey(projectId: string, threadId: string): string {
  return `${projectId}\0${threadId}`
}

/**
 * Resolve a shared or isolated context from trusted persisted state.
 * The renderer supplies identity, never a filesystem root; main validates both
 * the persisted project and the thread's membership before deriving that root.
 * Persisted worktree paths are diagnostic only: the manager reconstructs and
 * validates the registered checkout before its root can enter the run context.
 */
export function resolveThreadExecutionContext(
  projectId: string,
  threadId: string,
  dependencies: ThreadExecutionContextDependencies = defaultDependencies,
): Promise<ThreadExecutionContext> {
  let flights = resolutionFlights.get(dependencies)
  if (!flights) {
    flights = new Map()
    resolutionFlights.set(dependencies, flights)
  }
  const key = executionOwnerKey(projectId, threadId)
  const existing = flights.get(key)
  if (existing) return existing

  const pending = resolveThreadExecutionContextUncached(projectId, threadId, dependencies)
  flights.set(key, pending)
  const clear = (): void => {
    if (flights.get(key) === pending) flights.delete(key)
  }
  // Supplying both handlers means this cleanup branch always resolves; callers
  // still receive the original promise and its original rejection.
  void pending.then(clear, clear)
  return pending
}

async function resolveThreadExecutionContextUncached(
  projectId: string,
  threadId: string,
  dependencies: ThreadExecutionContextDependencies,
): Promise<ThreadExecutionContext> {
  const projectRoot = dependencies.getProjectRoot(projectId)
  if (!projectRoot) throw new Error(`Cannot resolve root for project "${projectId}"`)

  const threadMeta = await dependencies.getThreadMeta(projectId, threadId)
  if (threadMeta == null) {
    throw new Error(`Thread "${threadId}" is not persisted yet under project "${projectId}"`)
  }
  if (threadMeta.id !== threadId) {
    throw new Error(`Thread "${threadId}" does not belong to project "${projectId}"`)
  }

  if (threadMeta.worktree) {
    const restored =
      threadMeta.worktree.retiredAt === undefined && !threadMeta.worktree.pullRequestUrl
        ? threadMeta.worktree
        : await (dependencies.restoreWorktree ?? restoreRetiredThreadWorktree)({
            projectId,
            threadId,
            projectRoot,
            worktree: threadMeta.worktree,
          })
    const validate = dependencies.validateWorktree ?? validateThreadWorktree
    const worktree = await validate({
      projectId,
      threadId,
      projectRoot,
      worktree: restored,
    })
    if (
      restored !== threadMeta.worktree ||
      worktree.branch !== threadMeta.worktree.branch ||
      threadMeta.gitBranch !== worktree.branch
    ) {
      const adopted: ThreadWorktree = {
        path: restored.path,
        branch: worktree.branch,
        baseBranch: threadMeta.worktree.baseBranch,
        baseCommit: threadMeta.worktree.baseCommit,
        createdAt: threadMeta.worktree.createdAt,
        seededFromDirtyProject: threadMeta.worktree.seededFromDirtyProject,
        ...(threadMeta.worktree.pullRequestUrl
          ? { pullRequestUrl: threadMeta.worktree.pullRequestUrl }
          : {}),
      }
      await dependencies.syncWorktreeBranch?.(projectId, threadId, adopted)
    }
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
    const context = await resolveThreadExecutionContext(projectId, threadId, dependencies)
    // Agent turns may invoke find_files immediately. Prewarm the execution
    // root here so that index-dependent tools can ride the in-flight build,
    // while read-only renderer selection stays indexing-free (#1728).
    if (context.checkoutMode === 'worktree') dependencies.startWorktreeIndexing?.(context.root)
    return context
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

/**
 * Owner-only binding, for callers that own run-scoped state but have no
 * filesystem root of their own to impose.
 *
 * The ACP native-tool bridge is the motivating case: its MCP request handlers
 * are a separate async chain from the turn (see the note beside
 * `runWithActiveRunIdentity` in `acp-native-bridge.ts`), so the full context is
 * gone by the time a bridged tool executes. Binding the whole context there
 * would also rebind `root`, changing path resolution for every other bridged
 * tool; this binds identity only and leaves roots exactly as they were.
 */
const ownerStorage = new AsyncLocalStorage<ThreadExecutionOwner>()

export function runWithThreadExecutionOwner<T>(owner: ThreadExecutionOwner, fn: () => T): T {
  return ownerStorage.run(owner, fn)
}

/**
 * Resolve the stable owner of run-scoped state without exposing its filesystem
 * root. Prefers a full turn context; falls back to an owner-only binding.
 * Throws when neither is active — run-scoped state must never be written to a
 * guessed thread.
 */
export function requireThreadExecutionOwner(): ThreadExecutionOwner {
  const context = storage.getStore()
  if (context) return { projectId: context.projectId, threadId: context.threadId }
  const owner = ownerStorage.getStore()
  if (owner) return owner
  throw new Error('No thread execution context is active')
}
