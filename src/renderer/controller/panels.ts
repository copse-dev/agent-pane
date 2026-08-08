import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { RightPanelMode } from '@shared/types/state.ts'
import type { CanvasArtefact } from '@shared/types/canvas.ts'
import { addProject } from './projects.ts'

/** Keep `#pane-files` visibility in sync with store state (also wired via `files_pane_changed`). */
export function syncFilesPaneDom(store: AppStore): void {
  if (typeof document === 'undefined') return
  const pane = document.getElementById('pane-files')
  if (pane) pane.hidden = !store.getState().filesPaneOpen
}

/**
 * Expand the open pane over chat, or restore the split view. Purely a layout
 * state: the pane keeps its mode and selection either way.
 */
export function setRightPanelMaximized(store: AppStore, maximized: boolean): void {
  if (store.getState().rightPanelMaximized === maximized) return
  store.setState({ rightPanelMaximized: maximized })
  store.emit('right_panel_maximized_changed')
}

export function toggleRightPanelMaximized(store: AppStore): void {
  setRightPanelMaximized(store, !store.getState().rightPanelMaximized)
}

/** Whether a pane is actually covering chat — only an open panel can. */
export function isRightPanelMaximized(store: AppStore): boolean {
  const { filesPaneOpen, rightPanelMaximized } = store.getState()
  return filesPaneOpen && rightPanelMaximized
}

/**
 * Closing the panel gives chat the window back, so the expanded state has
 * nothing left to apply to. Clearing it here also means reopening the panel
 * lands on the ordinary split rather than silently covering chat again.
 */
function clearMaximizedOnClose(store: AppStore): void {
  if (!store.getState().rightPanelMaximized) return
  store.setState({ rightPanelMaximized: false })
  store.emit('right_panel_maximized_changed')
}

export function toggleFilesPane(store: AppStore): void {
  const open = !store.getState().filesPaneOpen
  store.setState({
    filesPaneOpen: open,
    ...(open ? { rightPanelMode: 'explorer' as const } : {}),
  })
  if (!open) clearMaximizedOnClose(store)
  syncFilesPaneDom(store)
  store.emit('files_pane_changed')
  if (open) store.emit('right_panel_mode_changed')
}

export function openRightPanel(store: AppStore, mode: RightPanelMode): void {
  const { filesPaneOpen, rightPanelMode } = store.getState()
  if (filesPaneOpen && rightPanelMode === mode) {
    syncFilesPaneDom(store)
    return
  }
  store.setState({ filesPaneOpen: true, rightPanelMode: mode })
  syncFilesPaneDom(store)
  store.emit('files_pane_changed')
  store.emit('right_panel_mode_changed')
}

/** Open the Changes panel and reveal the diff for a workspace-relative file path. */
export function navigateToChange(store: AppStore, path: string): void {
  store.emit('git_change_navigate', path)
  openRightPanel(store, 'changes')
}

/** Open the Roadmap pane with a specific item selected (quick-open palette hit). */
export function navigateToRoadmapItem(store: AppStore, itemId: string): void {
  openRightPanel(store, 'roadmap')
  store.emit('roadmap_reveal', itemId)
}

export function openBrowserUrl(store: AppStore, url: string): void {
  openRightPanel(store, 'browser')
  store.emit('browser_url_requested', url)
}

export function openPullRequest(
  store: AppStore,
  ref: { owner: string; repo: string; number: number },
): void {
  openRightPanel(store, 'prs')
  store.emit('pr_open_requested', ref.owner, ref.repo, ref.number)
}

/** Surface an MCP-UI artefact in the canvas (Browser pane). */
export function openCanvasArtefact(store: AppStore, artefact: CanvasArtefact): void {
  openRightPanel(store, 'browser')
  store.emit('canvas_artefact_requested', artefact)
}

export function toggleRightPanel(store: AppStore, mode: RightPanelMode): void {
  const { filesPaneOpen, rightPanelMode } = store.getState()
  if (filesPaneOpen && rightPanelMode === mode) {
    store.setState({ filesPaneOpen: false })
    clearMaximizedOnClose(store)
    syncFilesPaneDom(store)
    store.emit('files_pane_changed')
    return
  }
  store.setState({ filesPaneOpen: true, rightPanelMode: mode })
  syncFilesPaneDom(store)
  store.emit('files_pane_changed')
  store.emit('right_panel_mode_changed')
}

export function ensureWorkspaceForPanel(api: ApiClient, store: AppStore): boolean {
  if (store.getState().workspaceRoot) return true
  void addProject(store, api)
  return false
}

export function openRightPanelWithWorkspace(
  store: AppStore,
  api: ApiClient,
  mode: RightPanelMode,
): void {
  if (!ensureWorkspaceForPanel(api, store)) return
  openRightPanel(store, mode)
}

export function toggleRightPanelWithWorkspace(
  store: AppStore,
  api: ApiClient,
  mode: RightPanelMode,
): void {
  if (!ensureWorkspaceForPanel(api, store)) return
  toggleRightPanel(store, mode)
}

export function toggleFilesPaneWithWorkspace(store: AppStore, api: ApiClient): void {
  if (!store.getState().workspaceRoot) {
    void addProject(store, api)
    return
  }
  toggleFilesPane(store)
}
