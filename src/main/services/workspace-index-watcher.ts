import * as fs from 'node:fs'
import { buildIndex } from './file-index.ts'
import { getWorkspaceRoot } from './workspace.ts'

const REBUILD_DEBOUNCE_MS = 500

let watcher: fs.FSWatcher | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let watchedRoot: string | null = null
let rebuildInFlight: Promise<void> | null = null

export function startWorkspaceIndexWatcher(root: string): void {
  stopWorkspaceIndexWatcher()
  watchedRoot = root

  try {
    watcher = fs.watch(root, { recursive: true, persistent: false }, () => {
      scheduleIndexRebuild()
    })
  } catch (err) {
    console.warn('[agent-pane] workspace index watcher unavailable:', err)
  }
}

export function stopWorkspaceIndexWatcher(): void {
  watcher?.close()
  watcher = null
  watchedRoot = null
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
}

export function scheduleIndexRebuild(): void {
  const root = watchedRoot ?? getWorkspaceRoot()
  if (!root) return

  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    rebuildInFlight = buildIndex(root).catch((err) => {
      console.warn('[agent-pane] file index rebuild failed:', err)
    })
  }, REBUILD_DEBOUNCE_MS)
}

/** Test hook — await any in-flight debounced rebuild. */
export async function flushScheduledIndexRebuild(): Promise<void> {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
    const root = watchedRoot ?? getWorkspaceRoot()
    if (root) rebuildInFlight = buildIndex(root)
  }
  await rebuildInFlight
  rebuildInFlight = null
}
