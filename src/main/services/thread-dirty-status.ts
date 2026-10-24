import { getGitStatus } from './github/git-service.ts'

interface CacheEntry {
  updatedAt: number
  hasChanges: boolean
  checkedAt: number
}

/**
 * How long a cached answer is served for an unchanged `updatedAt`. A commit or
 * discard made outside the thread does not touch its metadata, so without a
 * bound the activity group would stay stale until the thread next changed.
 */
const RECHECK_AFTER_MS = 30_000

const cache = new Map<string, CacheEntry>()
const pending = new Map<string, Promise<boolean>>()

/**
 * Whether a settled thread's checkout root has uncommitted work, cached
 * per thread and checkout root against the thread's own `updatedAt` so a repeat poll (the mobile activity
 * feed, later the desktop Activity panel) re-runs `git status` once per
 * actual change to the thread, or once per {@link RECHECK_AFTER_MS}, rather
 * than once per poll. Lazy: nothing is computed until a caller actually asks
 * about that thread.
 */
export async function threadHasUncommittedChanges(
  threadId: string,
  root: string,
  updatedAt: number,
): Promise<boolean> {
  // Thread ids can repeat across projects; a result belongs to its checkout.
  const key = JSON.stringify([threadId, root])
  const cached = cache.get(key)
  if (
    cached &&
    cached.updatedAt === updatedAt &&
    Date.now() - cached.checkedAt < RECHECK_AFTER_MS
  ) {
    return cached.hasChanges
  }

  const inFlight = pending.get(key)
  if (inFlight) return inFlight

  const compute = (async (): Promise<boolean> => {
    try {
      const checkedAt = Date.now()
      const status = await getGitStatus(root)
      const hasChanges = status !== null && (status.staged.length > 0 || status.unstaged.length > 0)
      cache.set(key, { updatedAt, hasChanges, checkedAt })
      return hasChanges
    } finally {
      pending.delete(key)
    }
  })()
  pending.set(key, compute)
  return compute
}

/** Test-only: drop every cached entry between runs. */
export function resetThreadDirtyStatusCacheForTest(): void {
  cache.clear()
  pending.clear()
}
