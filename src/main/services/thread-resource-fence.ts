import { AsyncLocalStorage } from 'node:async_hooks'
import { runSerialized } from './storage/write-queue.ts'
import { getThreadMeta } from './thread-store.ts'

export interface ThreadResourceOwner {
  projectId: string
  threadId: string
}

interface ThreadResourceState {
  readonly id: string
  readonly archivedAt?: number
}

type ResourceStateLookup = (owner: ThreadResourceOwner) => Promise<ThreadResourceState | null>
const resourceStateLookup = new AsyncLocalStorage<ResourceStateLookup>()

/** Explicit hosts supply their own lifecycle instead of reading the ambient profile. */
export function runWithThreadResourceStateLookup<T>(
  lookup: ResourceStateLookup,
  operation: () => T,
): T {
  return resourceStateLookup.run(lookup, operation)
}

/** Same lock as checkout preparation and archival; never acquire it recursively. */
export function withThreadResourceFence<T>(
  owner: ThreadResourceOwner,
  operation: () => Promise<T>,
): Promise<T> {
  if (!/^[\w-]{1,128}$/.test(owner.projectId) || !/^[\w-]{1,128}$/.test(owner.threadId))
    return Promise.reject(new Error('Invalid thread resource owner.'))
  return runSerialized(`thread-checkout:${owner.projectId}:${owner.threadId}`, operation)
}

/** Hold through root resolution, process spawn and registration, never its lifetime. */
export function createThreadResource<T>(
  owner: ThreadResourceOwner,
  operation: () => Promise<T>,
): Promise<T> {
  return withThreadResourceFence(owner, async () => {
    const lookup = resourceStateLookup.getStore()
    const meta = lookup ? await lookup(owner) : await getThreadMeta(owner.projectId, owner.threadId)
    if (!meta || meta.id !== owner.threadId || meta.archivedAt !== undefined)
      throw new Error('That chat is no longer available for new processes.')
    return operation()
  })
}
