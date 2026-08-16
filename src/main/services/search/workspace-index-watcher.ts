import * as fs from 'node:fs'
import { resolve } from 'node:path'
import { buildIndex } from './file-index.ts'
import { isActiveSshWorkspace } from '../ssh-workspace/execution-target.ts'
import { isIgnoredWorkspacePath } from './index-ignore.ts'
import { updateSemanticIndex } from './semantic-index.ts'
import {
  notifyWorkspaceChanged,
  shouldPublishWorkingTreeChange,
} from './workspace-change-notify.ts'

const REBUILD_DEBOUNCE_MS = 500

/**
 * Ceiling on watch-only (no index rebuild) roots. Git IPC arms these when the
 * Changes pane or branch UI reads a thread checkout that search indexing has
 * not registered — isolated worktrees before the first agent turn, or a
 * workspace whose scale policy skipped the index watcher. Index-rebuild
 * watchers are owned by workspace/worktree lifecycle and are not pruned here.
 */
const MAX_WATCH_ONLY_ROOTS = 8

interface RootWatchState {
  watcher: fs.FSWatcher | null
  debounceTimer: ReturnType<typeof setTimeout> | null
  rebuildInFlight: Promise<void> | null
  rebuildQueued: boolean
  /**
   * Whether a rebuild for this root also refreshes the semantic index. True
   * for the primary workspace root; worktree execution roots opt out because
   * they reuse that shared semantic snapshot with a local delta overlay.
   */
  withSemantic: boolean
  /**
   * Whether disk events also rebuild the file index. False for the git-only
   * arm: renderer Git IPCs must not start a checkout listing (#1728).
   */
  withIndexRebuild: boolean
}

/** One watcher + rebuild-coalescing state per execution root (workspace or worktree, #1400). */
const states = new Map<string, RootWatchState>()

function emptyState(opts: { withSemantic: boolean; withIndexRebuild: boolean }): RootWatchState {
  return {
    watcher: null,
    debounceTimer: null,
    rebuildInFlight: null,
    rebuildQueued: false,
    withSemantic: opts.withSemantic,
    withIndexRebuild: opts.withIndexRebuild,
  }
}

function pruneWatchOnlyRoots(keepKey: string): void {
  const watchOnly = [...states.entries()].filter(
    ([key, state]) => key !== keepKey && state.watcher != null && !state.withIndexRebuild,
  )
  const overflow = watchOnly.length + 1 - MAX_WATCH_ONLY_ROOTS
  if (overflow <= 0) return
  for (const [key] of watchOnly.slice(0, overflow)) stopOne(key)
}

function armWatcher(
  root: string,
  opts: { withSemantic: boolean; withIndexRebuild: boolean },
): void {
  const key = resolve(root)
  // fs.watch observes only local files. Remote indexing is refreshed when
  // Copse writes, and external remote edits require a future SSH watcher.
  if (isActiveSshWorkspace()) return

  const existing = states.get(key)
  if (existing?.watcher) {
    const upgradedToIndex = !existing.withIndexRebuild && opts.withIndexRebuild
    if (opts.withSemantic) existing.withSemantic = true
    if (opts.withIndexRebuild) existing.withIndexRebuild = true
    // Events during the git-only window did not rebuild the listing. Catch up
    // the moment search indexing claims this watcher.
    if (upgradedToIndex) scheduleIndexRebuild(key)
    return
  }

  if (!opts.withIndexRebuild) pruneWatchOnlyRoots(key)

  const state = existing ?? emptyState(opts)
  if (opts.withSemantic) state.withSemantic = true
  if (opts.withIndexRebuild) state.withIndexRebuild = true
  states.set(key, state)

  try {
    const watcher = fs.watch(root, { recursive: true, persistent: false }, (_event, filename) => {
      handleWorkspaceWatchEvent(key, filename)
    })
    // Same contract as execution-root-watcher: an `error` with no listener is an
    // uncaught exception that kills the main process. A deleted, renamed, or
    // unmounted workspace root must drop the watcher, not take the app down.
    watcher.on('error', (err: unknown) => {
      console.warn('[copse-panel] workspace index watcher failed for', key, err)
      if (states.get(key)?.watcher === watcher) stopOne(key)
    })
    state.watcher = watcher
  } catch (err) {
    console.warn('[copse-panel] workspace index watcher unavailable:', err)
  }
}

/**
 * Arm a recursive watcher for git UI without listing the checkout.
 *
 * Isolated threads live outside the project root, and `startExecutionRootIndexing`
 * only runs at the start of an agent turn. Renderer Git IPCs (Changes, branch
 * status, follow-up +/-) must still see external edits, but must not pay for a
 * full `rg --files` as a side effect of selecting a thread (#1728).
 */
export function ensureWorkingTreeWatched(root: string): void {
  armWatcher(root, { withSemantic: false, withIndexRebuild: false })
}

export function startWorkspaceIndexWatcher(
  root: string,
  opts: { withSemantic?: boolean } = {},
): void {
  armWatcher(root, { withSemantic: opts.withSemantic ?? true, withIndexRebuild: true })
}

/** Route one recursive watcher event to git consumers and the narrower index rebuild path. */
export function handleWorkspaceWatchEvent(root: string, filename: string | null): void {
  if (shouldPublishWorkingTreeChange(filename)) notifyWorkspaceChanged(root)
  const state = states.get(resolve(root))
  if (!state?.withIndexRebuild) return
  // Ignore churn under build output / deps / .git / agent worktrees — none of
  // it is indexed, and a burst there (e.g. a `dist/` rebuild or git op) would
  // otherwise keep re-arming the semantic index treadmill (#517 follow-up).
  if (filename !== null && isIgnoredWorkspacePath(filename)) return
  scheduleIndexRebuild(root)
}

/**
 * Whether a live recursive watcher is re-listing this root on disk changes.
 *
 * A watched-for-index root's listing is current by construction, so
 * re-registering it never needs a fresh listing (#1694). Git-only watches do
 * not count: they publish working-tree events without rebuilding the file
 * index. False when `fs.watch` never armed — an SSH workspace, or a platform
 * that refused the recursive watch — and those roots fall back to an age check
 * instead.
 */
export function isRootWatched(root: string): boolean {
  const state = states.get(resolve(root))
  return state?.watcher != null && state.withIndexRebuild
}

/** Whether any recursive watcher (git-only or index-rebuild) is armed for `root`. */
export function isWorkingTreeWatched(root: string): boolean {
  return states.get(resolve(root))?.watcher != null
}

/** Test hook — fire the watcher's `error` path without deleting the directory. */
export function emitWorkspaceIndexWatcherErrorForTest(root: string, err: Error): boolean {
  const watcher = states.get(resolve(root))?.watcher
  if (!watcher) return false
  watcher.emit('error', err)
  return true
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
    state = emptyState({ withSemantic: true, withIndexRebuild: true })
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
