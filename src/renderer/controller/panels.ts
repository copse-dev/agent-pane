import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { RightPanelMode } from '@shared/types/state.ts'
import { addProject } from './projects.ts'

export function toggleFilesPane(store: AppStore): void {
  const open = !store.getState().filesPaneOpen
  store.setState({
    filesPaneOpen: open,
    ...(open ? { rightPanelMode: 'explorer' as const } : {}),
  })
  store.emit('files_pane_changed')
  if (open) store.emit('right_panel_mode_changed')
}

export function openRightPanel(store: AppStore, mode: RightPanelMode): void {
  const { filesPaneOpen, rightPanelMode } = store.getState()
  if (filesPaneOpen && rightPanelMode === mode) return
  store.setState({ filesPaneOpen: true, rightPanelMode: mode })
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

export function toggleFilesPaneWithWorkspace(store: AppStore, api: ApiClient): void {
  if (!store.getState().workspaceRoot) {
    void addProject(store, api)
    return
  }
  toggleFilesPane(store)
}
