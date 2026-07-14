import { buildIndex } from './file-index.ts'
import { ensureSemanticIndex } from './semantic-index.ts'
import { setSemanticIndexUnavailable } from './index-status.ts'
import { isActiveSshWorkspace } from '../ssh-workspace/execution-target.ts'
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
 *
 * SSH workspaces skip semantic indexing (v1) and the local fs.watch watcher
 * (remote edits are handled in Phase 3c); file index builds via remote rg/find.
 */
export function startWorkspaceIndexing(root: string): void {
  void buildIndex(root).catch((err: unknown) => {
    console.warn('[copse-panel] file index build failed:', err)
  })
  if (isActiveSshWorkspace()) {
    setSemanticIndexUnavailable()
    return
  }
  void ensureSemanticIndex(root)
  startWorkspaceIndexWatcher(root)
}
