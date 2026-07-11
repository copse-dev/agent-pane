import * as fs from 'node:fs'
import { buildIndex } from './file-index.ts'
import { getWorkspaceRoot } from '../workspace.ts'
import { isIgnoredWorkspacePath } from './index-ignore.ts'
import { updateSemanticIndex } from './semantic-index.ts'

const REBUILD_DEBOUNCE_MS = 500

let watcher: fs.FSWatcher | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let watchedRoot: string | null = null
let rebuildInFlight: Promise<void> | null = null
let rebuildQueued = false

export function startWorkspaceIndexWatcher(root: string): void {
  stopWorkspaceIndexWatcher()
  watchedRoot = root

  try {
    watcher = fs.watch(root, { recursive: true, persistent: false }, (_event, filename) => {
      // Ignore churn under build output / deps / .git / agent worktrees — none of
      // it is indexed, and a burst there (e.g. a `dist/` rebuild or git op) would
      // otherwise keep re-arming the semantic index treadmill (#517 follow-up).
      if (filename !== null && isIgnoredWorkspacePath(filename)) return
      scheduleIndexRebuild()
    })
  } catch (err) {
    console.warn('[copse-panel] workspace index watcher unavailable:', err)
  }
}

export function stopWorkspaceIndexWatcher(): void {
  watcher?.close()
  watcher = null
  watchedRoot = null
  rebuildQueued = false
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
}

/**
 * Start (or coalesce onto) a full index rebuild.
 *
 * A whole-repo `rg --files` + semantic reindex can outlast the debounce window,
 * so a burst of changes must not stack fresh rebuilds on top of an in-flight
 * one. At most one runs at a time; a request that lands mid-run sets
 * `rebuildQueued`, and the finished run kicks off exactly one trailing pass —
 * mirroring the semantic index's own coalescer (#517).
 */
function startRebuild(root: string): void {
  if (rebuildInFlight) {
    rebuildQueued = true
    return
  }
  rebuildInFlight = Promise.all([buildIndex(root), updateSemanticIndex(root)])
    .then(() => undefined)
    .catch((err: unknown) => {
      console.warn('[copse-panel] workspace index rebuild failed:', err)
    })
    .finally(() => {
      rebuildInFlight = null
      if (rebuildQueued) {
        rebuildQueued = false
        startRebuild(root)
      }
    })
}

export function scheduleIndexRebuild(): void {
  const root = watchedRoot ?? getWorkspaceRoot()
  if (!root) return

  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    startRebuild(root)
  }, REBUILD_DEBOUNCE_MS)
}

/** Test hook — await any in-flight or debounced rebuild, including a trailing pass. */
export async function flushScheduledIndexRebuild(): Promise<void> {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
    const root = watchedRoot ?? getWorkspaceRoot()
    if (root) startRebuild(root)
  }
  while (rebuildInFlight) await rebuildInFlight
}
