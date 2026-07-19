import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentHost } from '@copse/agent/agent-host.ts'
import type { StreamChunk } from '@shared/types'
import { classifyAgentError } from './agent-errors.ts'
import { getThreadMeta } from './thread-store.ts'
import { getProjectRoot } from './workspace.ts'

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
  getProjectRoot: (projectId: string) => string | null
  getThreadMeta: (projectId: string, threadId: string) => Promise<{ readonly id: string } | null>
}

const storage = new AsyncLocalStorage<ThreadExecutionContext>()

const defaultDependencies: ThreadExecutionContextDependencies = {
  getProjectRoot,
  getThreadMeta,
}

/**
 * Resolve the initial shared-checkout context from trusted persisted state.
 * The renderer supplies identity, never a filesystem root; main validates both
 * the persisted project and the thread's membership before deriving that root.
 * Worktree-aware resolution will extend this boundary once checkout metadata exists.
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

  return Object.freeze({
    projectId,
    threadId,
    projectRoot,
    root: projectRoot,
    checkoutMode: 'shared',
    branch: null,
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
