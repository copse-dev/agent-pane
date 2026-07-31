import { buildIndex, invalidateIndex } from './file-index.ts'
import { ensureSemanticIndex } from './semantic-index.ts'
import { setSemanticIndexUnavailable } from './index-status.ts'
import { isActiveSshWorkspace } from '../ssh-workspace/execution-target.ts'
import { startWorkspaceIndexWatcher, stopWorkspaceIndexWatcher } from './workspace-index-watcher.ts'

/** The most recently opened renderer-selected workspace root, if any. */
let primaryWorkspaceRoot: string | null = null

/**
 * Kick off all workspace indexing without blocking the caller.
 *
 * Opening a workspace must not wait on index builds — the renderer swaps to
 * the full layout immediately and the footer index indicator reports build
 * progress instead. Consumers that need the file index ride the in-flight
 * build via `whenFileIndexReady()`; semantic searches already coalesce onto
 * the in-flight `ensureSemanticIndex` run.
 *
 * Every open path (workspace:open / workspace:set IPC, the native
 * File ▸ Open Folder menu) must go through here so none of them misses the
 * semantic index or the rebuild watcher.
 *
 * SSH workspaces skip semantic indexing (v1) and the local fs.watch watcher
 * (remote edits are handled in Phase 3c). The in-memory file index still builds
 * via remote `rg --files` / `find` — that can surface as the footer chip
 * ("Building file index…"), which is not gortex. Listings use a longer timeout
 * than ordinary tool subprocesses (`FILE_INDEX_LIST_TIMEOUT_MS`).
 */
export function startWorkspaceIndexing(root: string): void {
  // Switching workspaces replaces the previous primary root: drop its watcher
  // and stale index rather than accumulating one entry per folder ever opened.
  // Worktree execution roots (registered via startExecutionRootIndexing) are
  // untouched — they track their own thread's lifetime, not the renderer's
  // selected workspace.
  const previous = primaryWorkspaceRoot
  primaryWorkspaceRoot = root
  if (previous && previous !== root) {
    stopWorkspaceIndexWatcher(previous)
    invalidateIndex(previous)
  }

  void buildIndex(root).catch((err: unknown) => {
    console.warn('[copse-panel] file index build failed:', err)
  })
  if (isActiveSshWorkspace()) {
    setSemanticIndexUnavailable()
    return
  }
  void ensureSemanticIndex(root)
  startWorkspaceIndexWatcher(root, { withSemantic: true })
}

/**
 * Kick off file indexing (and its rebuild watcher) for a thread's worktree
 * execution root — a linked checkout under `~/.copse/worktrees/<project>/
 * <thread>/`, outside the primary workspace root the functions above cover.
 *
 * Deliberately skips semantic indexing: gortex scopes its shared daemon to one
 * active repo (`scopeGortexToActiveRepo`), so tracking every worktree
 * alongside the workspace would repeatedly untrack/re-track and thrash it.
 * Worktree threads fall back to regex/text search for "by meaning" queries,
 * the same posture SSH workspaces already take (see `semanticIndexBuildingNote`).
 *
 * Safe to call repeatedly for the same root — both the file-index build and
 * the watcher registration are no-ops once already in place — so callers can
 * fire this on every worktree context resolution rather than tracking whether
 * a given thread has already been registered.
 */
export function startExecutionRootIndexing(root: string): void {
  void buildIndex(root).catch((err: unknown) => {
    console.warn('[copse-panel] execution root index build failed:', err)
  })
  startWorkspaceIndexWatcher(root, { withSemantic: false })
}

/** Release a worktree execution root's index/watcher once its thread's checkout is retired. */
export function stopExecutionRootIndexing(root: string): void {
  stopWorkspaceIndexWatcher(root)
  invalidateIndex(root)
}
