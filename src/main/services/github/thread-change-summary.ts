import type { ThreadChangeSummary } from '@shared/types/git.ts'
import { isNonNull } from '@shared/nullish.ts'

export interface ThreadChangeRef {
  projectId: string
  threadId: string
}

export interface ThreadChangeSummaryDeps {
  /**
   * The checkout a thread runs in. Must not arm a file watcher: this read is
   * inspect-only, and watching one root per sidebar row is what made the
   * Activity sidebar re-read every thread's status on one working-tree event.
   */
  resolveRoot: (projectId: string, threadId: string) => Promise<string | null>
  read: (root: string) => Promise<ThreadChangeSummary | null>
  now?: () => number
  ttlMs?: number
  concurrency?: number
}

interface CacheEntry {
  at: number
  promise: Promise<ThreadChangeSummary | null>
}

/**
 * Per-thread "unlanded work" summaries for the sidebar. Threads are grouped by
 * resolved root, so N threads sharing the project checkout cost one read; a
 * root's result is cached for a short TTL with a single in-flight promise, and
 * distinct roots are read at most `concurrency` at a time.
 */
export function createThreadChangeSummaryReader(deps: ThreadChangeSummaryDeps) {
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? 2_000
  const concurrency = Math.max(1, deps.concurrency ?? 3)
  const cache = new Map<string, CacheEntry>()

  function readRoot(root: string, fresh: boolean): Promise<ThreadChangeSummary | null> {
    const hit = cache.get(root)
    if (hit && !fresh && now() - hit.at < ttlMs) return hit.promise
    const promise = deps.read(root).catch(() => null)
    cache.set(root, { at: now(), promise })
    return promise
  }

  return async function summarize(
    refs: readonly ThreadChangeRef[],
    opts: { fresh?: boolean } = {},
  ): Promise<Array<ThreadChangeSummary | null>> {
    for (const [root, entry] of cache) if (now() - entry.at >= ttlMs) cache.delete(root)
    const roots = await Promise.all(
      refs.map((ref) => deps.resolveRoot(ref.projectId, ref.threadId).catch((): null => null)),
    )
    const unique = [...new Set(roots.filter(isNonNull))]
    const results = new Map<string, ThreadChangeSummary | null>()
    let next = 0
    const worker = async (): Promise<void> => {
      for (let i = next++; i < unique.length; i = next++) {
        const root = unique[i]
        if (root !== undefined) results.set(root, await readRoot(root, opts.fresh === true))
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker))
    return roots.map((root) => (root === null ? null : (results.get(root) ?? null)))
  }
}
