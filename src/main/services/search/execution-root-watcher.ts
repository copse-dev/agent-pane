import * as fs from 'node:fs'
import { isIgnoredWorkspacePath } from './index-ignore.ts'
import { invalidateSearchResultCacheUnderRoot } from './search-result-cache.ts'

/**
 * Watches whichever execution roots currently hold cached search results, so an
 * edit made outside the agent's own tool calls drops the affected results.
 *
 * Separate from {@link ./workspace-index-watcher.ts} on purpose. That one is a
 * single-root singleton driving index rebuilds, started only by the
 * workspace-open paths — it never sees a thread worktree, which lives under
 * `~/.copse/worktrees/<projectId>/<threadId>` rather than inside the project.
 * Rebuild coalescing there is load-bearing (#517), so cache invalidation gets
 * its own multi-root watcher instead of being grafted onto it.
 *
 * No debounce: invalidation is a Map delete, and delaying it is exactly the
 * window where a stale result could be served.
 */

const watchers = new Map<string, fs.FSWatcher>()

/**
 * Idempotently watch `root`. Returns false when no watcher could be
 * established — the caller must then treat the root as uncacheable rather than
 * cache results it can never invalidate.
 */
export function ensureExecutionRootWatched(root: string): boolean {
  if (watchers.has(root)) return true
  try {
    const watcher = fs.watch(root, { recursive: true, persistent: false }, (_event, filename) => {
      // Ignore churn under build output / deps / .git — none of it is searched,
      // and a burst there would clear the cache continuously.
      if (filename !== null && isIgnoredWorkspacePath(filename)) return
      invalidateSearchResultCacheUnderRoot(root)
    })
    watchers.set(root, watcher)
    return true
  } catch (err) {
    console.warn('[copse-panel] search cache watcher unavailable for', root, err)
    return false
  }
}

export function stopWatchingExecutionRoot(root: string): void {
  watchers.get(root)?.close()
  watchers.delete(root)
}

export function stopAllExecutionRootWatchers(): void {
  for (const watcher of watchers.values()) watcher.close()
  watchers.clear()
}

/** Test hook — which roots are currently watched. */
export function watchedExecutionRootsForTest(): string[] {
  return Array.from(watchers.keys())
}
