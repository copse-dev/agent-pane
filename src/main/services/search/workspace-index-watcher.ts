import * as fs from 'node:fs'
import { resolve } from 'node:path'
import { buildIndex } from './file-index.ts'
import { isActiveSshWorkspace } from '../ssh-workspace/execution-target.ts'
import { isIgnoredWorkspacePath } from './index-ignore.ts'
import { updateSemanticIndex } from './semantic-index.ts'

const REBUILD_DEBOUNCE_MS = 500

interface RootWatchState {
  watcher: fs.FSWatcher | null
  debounceTimer: ReturnType<typeof setTimeout> | null
  rebuildInFlight: Promise<void> | null
  rebuildQueued: boolean
  /**
   * Whether a rebuild for this root also refreshes the semantic index. True
   * for the primary workspace root; worktree execution roots opt out — gortex
   * scopes its daemon to one active repo at a time (`scopeGortexToActiveRepo`),
   * so tracking every worktree alongside the workspace would thrash it. Those
   * roots fall back to regex/text search instead (#1400).
   */
  withSemantic: boolean
}

/** One watcher + rebuild-coalescing state per execution root (workspace or worktree, #1400). */
const states = new Map<string, RootWatchState>()

export function startWorkspaceIndexWatcher(
  root: string,
  opts: { withSemantic?: boolean } = {},
): void {
  const key = resolve(root)
  const withSemantic = opts.withSemantic ?? true
  const existing = states.get(key)
  if (existing?.watcher) return // already watching this root

  // fs.watch observes only local files. Remote indexing is refreshed when
  // Copse writes, and external remote edits require a future SSH watcher.
  if (isActiveSshWorkspace()) return

  const state: RootWatchState = existing ?? {
    watcher: null,
    debounceTimer: null,
    rebuildInFlight: null,
    rebuildQueued: false,
    withSemantic,
  }
  state.withSemantic = withSemantic
  states.set(key, state)

  try {
    state.watcher = fs.watch(root, { recursive: true, persistent: false }, (_event, filename) => {
      // Ignore churn under build output / deps / .git / agent worktrees — none of
      // it is indexed, and a burst there (e.g. a `dist/` rebuild or git op) would
      // otherwise keep re-arming the semantic index treadmill (#517 follow-up).
      if (filename !== null && isIgnoredWorkspacePath(filename)) return
      scheduleIndexRebuild(key)
    })
  } catch (err) {
    console.warn('[copse-panel] workspace index watcher unavailable:', err)
  }
}

/** Stop watching one root, or every watched root when called with none (app quit / workspace switch). */
export function stopWorkspaceIndexWatcher(root?: string): void {
  if (root === undefined) {
    for (const key of [...states.keys()]) stopOne(key)
    return
  }
  stopOne(resolve(root))
}

function stopOne(key: string): void {
  const state = states.get(key)
  if (!state) return
  state.watcher?.close()
  if (state.debounceTimer) clearTimeout(state.debounceTimer)
  states.delete(key)
}

/**
 * Start (or coalesce onto) a full index rebuild for one root.
 *
 * A whole-repo `rg --files` + semantic reindex can outlast the debounce window,
 * so a burst of changes must not stack fresh rebuilds on top of an in-flight
 * one. At most one runs at a time per root; a request that lands mid-run sets
 * `rebuildQueued`, and the finished run kicks off exactly one trailing pass —
 * mirroring the semantic index's own per-root coalescer (#517).
 */
function startRebuild(key: string, root: string, state: RootWatchState): void {
  if (state.rebuildInFlight) {
    state.rebuildQueued = true
    return
  }
  state.rebuildInFlight = Promise.all([
    buildIndex(root),
    ...(state.withSemantic && !isActiveSshWorkspace() ? [updateSemanticIndex(root)] : []),
  ])
    .then(() => undefined)
    .catch((err: unknown) => {
      console.warn('[copse-panel] workspace index rebuild failed:', err)
    })
    .finally(() => {
      state.rebuildInFlight = null
      // Re-fetch: a rebuild that outlives `stopWorkspaceIndexWatcher` for this
      // root must not resurrect state for a root nobody is tracking anymore.
      if (states.get(key) !== state) return
      if (state.rebuildQueued) {
        state.rebuildQueued = false
        startRebuild(key, root, state)
      }
    })
}

export function scheduleIndexRebuild(root: string): void {
  const key = resolve(root)
  let state = states.get(key)
  if (!state) {
    state = {
      watcher: null,
      debounceTimer: null,
      rebuildInFlight: null,
      rebuildQueued: false,
      withSemantic: true,
    }
    states.set(key, state)
  }

  if (state.debounceTimer) clearTimeout(state.debounceTimer)
  state.debounceTimer = setTimeout(() => {
    const current = states.get(key)
    if (!current) return
    current.debounceTimer = null
    startRebuild(key, root, current)
  }, REBUILD_DEBOUNCE_MS)
}

/** Test hook — await any in-flight or debounced rebuild for one root, including a trailing pass. */
export async function flushScheduledIndexRebuild(root: string): Promise<void> {
  const key = resolve(root)
  const state = states.get(key)
  if (!state) return
  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer)
    state.debounceTimer = null
    startRebuild(key, root, state)
  }
  while (state.rebuildInFlight) await state.rebuildInFlight
}
