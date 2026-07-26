import type { AppStore } from '@shared/store/store.ts'

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
