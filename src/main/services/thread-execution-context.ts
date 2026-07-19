import { AsyncLocalStorage } from 'node:async_hooks'
import { getActiveProjectId, getProjectRoot } from './workspace.ts'

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

export interface ThreadExecutionContextDependencies {
  getActiveProjectId: () => string | null
  getProjectRoot: (projectId: string) => string | null
}

const storage = new AsyncLocalStorage<ThreadExecutionContext>()

const defaultDependencies: ThreadExecutionContextDependencies = {
  getActiveProjectId,
  getProjectRoot,
}

/**
 * Resolve the initial shared-checkout context from trusted persisted state.
 * Worktree-aware resolution and atomic thread-membership validation will extend this
 * boundary once the first-message transaction and worktree metadata exist.
 */
export function resolveThreadExecutionContext(
  threadId: string,
  dependencies: ThreadExecutionContextDependencies = defaultDependencies,
): ThreadExecutionContext {
  const projectId = dependencies.getActiveProjectId()
  if (!projectId) throw new Error('Cannot run thread without an active project')

  const projectRoot = dependencies.getProjectRoot(projectId)
  if (!projectRoot) throw new Error(`Cannot resolve root for active project "${projectId}"`)

  return Object.freeze({
    projectId,
    threadId,
    projectRoot,
    root: projectRoot,
    checkoutMode: 'shared',
    branch: null,
  })
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
