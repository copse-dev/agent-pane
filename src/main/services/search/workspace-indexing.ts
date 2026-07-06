import { buildIndex } from './file-index.ts'
import { ensureSemanticIndex } from './semantic-index.ts'
import { startWorkspaceIndexWatcher } from './workspace-index-watcher.ts'

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
 */
export function startWorkspaceIndexing(root: string): void {
  void buildIndex(root).catch((err: unknown) => {
    console.warn('[copse-panel] file index build failed:', err)
  })
  void ensureSemanticIndex(root)
  startWorkspaceIndexWatcher(root)
}
