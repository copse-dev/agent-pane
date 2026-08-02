import * as fs from 'node:fs'
import { join } from 'node:path'
import { isIgnoredWorkspacePath } from './index-ignore.ts'
import { cachedExecutionRoots, invalidateToolResultCacheForChange } from './tool-result-cache.ts'

/**
 * Watches whichever execution roots currently hold cached tool results, so an
 * edit made outside the agent's own tool calls drops the affected results.
 *
 * Separate from {@link ./workspace-index-watcher.ts} on purpose. That one is a
 * single-root singleton driving index rebuilds, started only by the
 * workspace-open paths — it never sees a thread worktree, which lives under
 * `~/.copse/worktrees/<projectId>/<threadId>` rather than inside the project
 * (see #1400). Rebuild coalescing there is load-bearing (#517), so cache
 * invalidation gets its own multi-root watcher instead of being grafted onto it.
 *
 * No debounce: invalidation is a Map delete, and delaying it is exactly the
 * window where a stale result could be served.
 */

const watchers = new Map<string, fs.FSWatcher>()

/**
 * Ceiling on concurrently watched roots. The cache holds at most 8 thread
 * buckets, so at most 8 roots are ever live — but roots change as threads come
 * and go, and a watcher outlives the bucket that created it. Without a bound
 * they accumulate for the life of the process, each one a *recursive* watch
 * (on Linux, an inotify watch per subdirectory of a whole checkout).
 */
const MAX_WATCHED_ROOTS = 8

/**
 * Close watchers for roots nothing caches anymore.
 *
 * Deliberately lazy — only called when about to exceed {@link MAX_WATCHED_ROOTS},
 * never on the event path. Pruning eagerly whenever an edit emptied a bucket
 * would close and reopen a recursive watch on every write burst, and reopening
 * one on a large checkout is exactly the expensive operation this is trying to
 * limit.
 */
function pruneUnusedWatchers(): void {
  const live = cachedExecutionRoots()
  for (const [root, watcher] of watchers) {
    if (live.has(root)) continue
    watcher.close()
    watchers.delete(root)
  }
}

/**
 * A moved branch pointer — `git checkout` / `git switch` from a terminal.
 * The working tree it rewrites generates its own events, but they arrive
 * file-by-file and a checkout that only touches ignored directories would
 * otherwise go unnoticed, so treat the pointer itself as "everything changed".
 *
 * Only fires for a normal checkout: a linked worktree's `.git` is a file
 * pointing at the common git dir, so its HEAD is out of watch range. Worktree
 * threads are covered instead by the branch in their execution context, which
 * `validateThreadWorktree` re-resolves each turn.
 */
function isBranchPointerChange(relPath: string): boolean {
  const segments = relPath.split(/[/\\]/)
  return segments.length === 2 && segments[0] === '.git' && segments[1] === 'HEAD'
}

/**
 * Idempotently watch `root`. Returns false when no watcher could be
 * established — the caller must then treat the root as uncacheable rather than
 * cache results it can never invalidate.
 */
export function ensureExecutionRootWatched(root: string): boolean {
  if (watchers.has(root)) return true
  if (watchers.size >= MAX_WATCHED_ROOTS) pruneUnusedWatchers()
  try {
    const watcher = fs.watch(root, { recursive: true, persistent: false }, (_event, filename) => {
      // fs.watch can omit the filename; without it the change can't be located,
      // so nothing under this root can be trusted.
      if (filename === null) {
        invalidateToolResultCacheForChange(root, null)
        return
      }
      if (isBranchPointerChange(filename)) {
        invalidateToolResultCacheForChange(root, null)
        return
      }
      // Ignore churn under build output / deps / .git — none of it is searched,
      // and a burst there would clear the cache continuously.
      if (isIgnoredWorkspacePath(filename)) return
      invalidateToolResultCacheForChange(root, join(root, filename))
    })
    watchers.set(root, watcher)
    return true
  } catch (err) {
    console.warn('[copse-panel] tool result cache watcher unavailable for', root, err)
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
