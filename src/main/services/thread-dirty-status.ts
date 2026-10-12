import { getGitStatus } from './github/git-service.ts'

interface CacheEntry {
  updatedAt: number
  hasChanges: boolean
}

const cache = new Map<string, CacheEntry>()
const pending = new Map<string, Promise<boolean>>()

/**
 * Whether a settled thread's checkout root has uncommitted work, cached
 * against the thread's own `updatedAt` so a repeat poll (the mobile activity
 * feed, later the desktop Activity panel) re-runs `git status` once per
 * actual change to the thread rather than once per poll. Lazy: nothing is
 * computed until a caller actually asks about that thread.
 */
export async function threadHasUncommittedChanges(
  threadId: string,
  root: string,
  updatedAt: number,
): Promise<boolean> {
  const cached = cache.get(threadId)
  if (cached && cached.updatedAt === updatedAt) return cached.hasChanges

  const inFlight = pending.get(threadId)
  if (inFlight) return inFlight

  const compute = (async (): Promise<boolean> => {
    try {
      const status = await getGitStatus(root)
      const hasChanges = status !== null && (status.staged.length > 0 || status.unstaged.length > 0)
      cache.set(threadId, { updatedAt, hasChanges })
      return hasChanges
    } finally {
      pending.delete(threadId)
    }
  })()
  pending.set(threadId, compute)
  return compute
}

/** Test-only: drop every cached entry between runs. */
export function resetThreadDirtyStatusCacheForTest(): void {
  cache.clear()
  pending.clear()
}
