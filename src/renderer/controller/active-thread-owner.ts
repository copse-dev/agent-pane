import type { AppStore } from '@shared/store/store.ts'
import type { AppState, Thread } from '@shared/types'

export interface ActiveThreadOwner {
  projectId: string
  threadId: string
}

/** Identity sent across IPC so main can derive the task's trusted execution root. */
export function getActiveThreadOwner(store: AppStore): ActiveThreadOwner | null {
  const { activeProjectId, activeThreadId } = store.getState()
  return activeProjectId && activeThreadId
    ? { projectId: activeProjectId, threadId: activeThreadId }
    : null
}

export function requireActiveThreadOwner(store: AppStore): ActiveThreadOwner {
  const owner = getActiveThreadOwner(store)
  if (!owner) throw new Error('No active task')
  return owner
}

/**
 * The active thread as `getThreadById` resolves it, read from `state` so it can
 * be a `store.select` selector. Thread writes replace only the thread they
 * patch, so selecting this (default `Object.is`) follows the active thread's
 * own updates, its messages and status included, and a switch, but not
 * another thread's rename, turn or hydration.
 */
export function activeThreadOf(state: AppState): Thread | undefined {
  const { activeThreadId, threads, backgroundThreads } = state
  if (!activeThreadId) return undefined
  return (
    threads.find((t) => t.id === activeThreadId) ??
    backgroundThreads.find((b) => b.thread.id === activeThreadId)?.thread
  )
}
