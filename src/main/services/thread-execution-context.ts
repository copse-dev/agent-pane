import type { AgentHost } from '@copse/agent/agent-host.ts'
import type { StreamChunk, Thread } from '@shared/types'
import { agentErrorNotice, classifyAgentError } from './agent-errors.ts'
import { getThreadMeta, updateMeta } from './thread-store.ts'
import { getProjectRoot, setExecutionRootAliasLookup } from './workspace.ts'
import {
  clearUpgradedThreadExecutionContext,
  currentThreadExecutionContext,
  setUpgradedThreadExecutionContext,
  threadExecutionContextStorage,
  type ThreadCheckoutMode,
  type ThreadExecutionContext,
} from './thread-execution-context-store.ts'
import {
  inspectManagedThreadWorktreePath,
  inspectThreadWorktreeAttachment,
  reattachThreadWorktree,
  restoreRetiredThreadWorktree,
  restoreMissingThreadWorktree,
  ThreadWorktreeDetachedError,
  validateThreadWorktree,
  validateThreadWorktreeRecovery,
  type ValidateWorktreeInput,
  type ValidatedThreadWorktree,
  type ValidatedThreadWorktreeRecovery,
} from './worktree-manager.ts'
import { startExecutionRootIndexing } from './search/workspace-indexing.ts'
import type { ThreadDeferredWorktree, ThreadWorktree } from '@shared/types/worktree.ts'
import type { ThreadWorktreeAttachment, ThreadWorktreeReattachResult } from '@shared/types/git.ts'

async function syncAdoptedWorktreeBranch(
  projectId: string,
  threadId: string,
  worktree: ThreadWorktree,
): Promise<void> {
  await updateMeta(projectId, threadId, { worktree, gitBranch: worktree.branch })
}

export type { ThreadCheckoutMode, ThreadExecutionContext }

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
    readonly automation?: NonNullable<Thread['automation']>
    readonly deferredWorktree?: ThreadDeferredWorktree
  } | null>
  validateWorktree?: (input: {
    projectId: string
    threadId: string
    projectRoot: string
    worktree: ThreadWorktree
  }) => Promise<ValidatedThreadWorktree>
  /** Validate a detached checkout only when Git has an active recovery marker. */
  validateWorktreeRecovery?: (input: {
    projectId: string
    threadId: string
    projectRoot: string
    worktree: ThreadWorktree
  }) => Promise<ValidatedThreadWorktreeRecovery>
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

const storage = threadExecutionContextStorage

const defaultDependencies: ThreadExecutionContextDependencies = {
  getProjectRoot,
  getThreadMeta,
  validateWorktree: validateThreadWorktree,
  validateWorktreeRecovery: validateThreadWorktreeRecovery,
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

/** Resolve the same validated checkout for a terminal as for the rest of the thread. */
export async function resolveThreadTerminalExecutionContext(
  projectId: string,
  threadId: string,
  dependencies: ThreadExecutionContextDependencies = defaultDependencies,
): Promise<ThreadExecutionContext> {
  return resolveThreadExecutionContext(projectId, threadId, dependencies)
}

/**
 * The trusted input for inspecting or repairing a thread's own checkout. Only
 * an active isolated worktree qualifies: a retired one is recreated on its
 * branch by `restoreRetiredThreadWorktree`, and a shared checkout is the
 * user's project directory, which Copse never reattaches on their behalf.
 */
async function activeThreadWorktreeInput(
  projectId: string,
  threadId: string,
): Promise<ValidateWorktreeInput | null> {
  const projectRoot = getProjectRoot(projectId)
  if (!projectRoot) throw new Error(`Cannot resolve root for project "${projectId}"`)
  const threadMeta = await getThreadMeta(projectId, threadId)
  if (threadMeta == null) {
    throw new Error(`Thread "${threadId}" is not persisted yet under project "${projectId}"`)
  }
  if (threadMeta.id !== threadId) {
    throw new Error(`Thread "${threadId}" does not belong to project "${projectId}"`)
  }
  const worktree = threadMeta.worktree
  if (!worktree || worktree.retiredAt !== undefined || worktree.pullRequestUrl) return null
  return { projectId, threadId, projectRoot, worktree }
}

/**
 * The checkout a thread would run in, for read-only inspection (sidebar status).
 * Unlike {@link resolveThreadExecutionContext} this never restores a retired
 * worktree, validates/adopts a branch, or rewrites thread metadata: a shared
 * thread yields the project root, an active isolated worktree its managed path
 * (only when the recorded path really is the managed one), and a retired or PR'd
 * worktree (which resolution would recreate) yields null.
 */
export async function inspectThreadCheckoutRoot(
  projectId: string,
  threadId: string,
  dependencies: Pick<ThreadExecutionContextDependencies, 'getProjectRoot' | 'getThreadMeta'> & {
    /** Read-only managed-path check; defaults to the worktree manager's. */
    inspectWorktreePath?: (
      projectId: string,
      threadId: string,
      recordedPath: string,
    ) => Promise<string | null>
  } = defaultDependencies,
): Promise<string | null> {
  const projectRoot = dependencies.getProjectRoot(projectId)
  if (!projectRoot) return null
  const threadMeta = await dependencies.getThreadMeta(projectId, threadId)
  if (threadMeta?.id !== threadId) return null
  const worktree = threadMeta.worktree
  if (!worktree) return projectRoot
  if (worktree.retiredAt !== undefined || worktree.pullRequestUrl) return null
  // The persisted path is untrusted: it must be the managed thread path, not
  // whatever the metadata says, before Git is pointed at it.
  return (dependencies.inspectWorktreePath ?? inspectManagedThreadWorktreePath)(
    projectId,
    threadId,
    worktree.path,
  )
}

/** Whether the thread's isolated checkout is detached; shared and retired checkouts report attached. */
export async function inspectThreadCheckoutAttachment(
  projectId: string,
  threadId: string,
): Promise<ThreadWorktreeAttachment> {
  const input = await activeThreadWorktreeInput(projectId, threadId)
  return input ? inspectThreadWorktreeAttachment(input) : { state: 'attached' }
}

/** Reattach the thread's detached isolated checkout to its recorded branch. */
export async function reattachThreadCheckout(
  projectId: string,
  threadId: string,
): Promise<ThreadWorktreeReattachResult> {
  const input = await activeThreadWorktreeInput(projectId, threadId)
  if (!input) throw new Error('Only an active thread worktree can be reattached')
  return reattachThreadWorktree(input)
}

/** Restore an externally removed checkout only after the user clicks in its owning thread. */
export async function restoreThreadCheckout(projectId: string, threadId: string): Promise<void> {
  const input = await activeThreadWorktreeInput(projectId, threadId)
  if (!input) throw new Error('Only an isolated thread worktree can be restored')
  const worktree = await restoreMissingThreadWorktree(input)
  await syncAdoptedWorktreeBranch(projectId, threadId, worktree)
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
    const input = { projectId, threadId, projectRoot, worktree: restored }
    const validate = dependencies.validateWorktree ?? validateThreadWorktree
    let worktree: ValidatedThreadWorktree | ValidatedThreadWorktreeRecovery
    try {
      worktree = await validate(input)
    } catch (error) {
      if (!(error instanceof ThreadWorktreeDetachedError)) throw error
      // Git detaches HEAD while replaying commits. Keep every thread surface
      // usable only when the registered checkout has an active recovery marker.
      const validateRecovery =
        dependencies.validateWorktreeRecovery ?? validateThreadWorktreeRecovery
      worktree = await validateRecovery(input)
    }
    if (
      worktree.branch !== null &&
      (restored !== threadMeta.worktree ||
        worktree.branch !== threadMeta.worktree.branch ||
        threadMeta.gitBranch !== worktree.branch)
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
      ...(threadMeta.automation ? { automation: { ...threadMeta.automation } } : {}),
    })
  }

  return Object.freeze({
    projectId,
    threadId,
    projectRoot,
    root: projectRoot,
    checkoutMode: 'shared',
    branch: threadMeta.gitBranch ?? null,
    ...(threadMeta.automation ? { automation: { ...threadMeta.automation } } : {}),
    ...(threadMeta.deferredWorktree ? { deferredWorktree: threadMeta.deferredWorktree } : {}),
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
    host.emit(threadId, { type: 'text', text: agentErrorNotice(classifyAgentError(error)) })
    host.emit(threadId, { type: 'done' })
    return null
  }
}

/** Bind a context to the complete async lifetime of an agent turn. */
export function runWithThreadExecutionContext<T>(context: ThreadExecutionContext, fn: () => T): T {
  return storage.run(context, fn)
}

/** Move every deferred context bound for this thread onto its new worktree. */
export function adoptUpgradedThreadExecutionContext(context: ThreadExecutionContext): void {
  if (context.checkoutMode !== 'worktree') {
    throw new Error('An upgraded execution context must own a worktree')
  }
  setUpgradedThreadExecutionContext(context)
}

/** Drop the upgrade once the turn that performed it has finished. */
export function releaseUpgradedThreadExecutionContext(owner: ThreadExecutionOwner): void {
  clearUpgradedThreadExecutionContext(owner)
}

function currentContext(): ThreadExecutionContext | undefined {
  return currentThreadExecutionContext() ?? undefined
}

export function getThreadExecutionContext(): ThreadExecutionContext | null {
  return currentContext() ?? null
}

// File tools in a worktree turn read an absolute path into the project checkout
// as the same file in the worktree (see `resolvePathWithinRoot`). Scoped to the
// turn's own root, so renderer IPC and any other explicit root are unaffected.
setExecutionRootAliasLookup((root) => {
  const context = currentContext()
  if (context?.checkoutMode !== 'worktree' || context.root !== root) return null
  return context.projectRoot
})

/** True while the active turn is a read-only view awaiting its first write. */
export function isThreadCheckoutDeferred(): boolean {
  return currentContext()?.deferredWorktree !== undefined
}

export function requireThreadExecutionContext(): ThreadExecutionContext {
  const context = currentContext()
  if (!context) throw new Error('No thread execution context is active')
  return context
}

/**
 * Resolve the stable owner of run-scoped state without exposing its filesystem
 * root. Throws when no context is active — run-scoped state must never be
 * written to a guessed thread.
 *
 * The ACP native-tool bridge's MCP request handlers are a separate async chain
 * from the turn (see the note beside `runWithActiveRunIdentity` in
 * `acp-native-bridge.ts`); the bridge rebinds the turn's full resolved context
 * around every bridged call (#1439), so this resolves on that chain too.
 */
export function requireThreadExecutionOwner(): ThreadExecutionOwner {
  const context = currentContext()
  if (context) return { projectId: context.projectId, threadId: context.threadId }
  throw new Error('No thread execution context is active')
}
