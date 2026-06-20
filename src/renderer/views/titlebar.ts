import { el } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { openSettingsDialog } from './settings-dialog.ts'
import { addProject } from '../controller/projects.ts'

function ensureWorkspaceForPanel(api: ApiClient, store: AppStore): boolean {
  if (store.getState().workspaceRoot) return true
  void addProject(store, api)
  return false
}

function basename(p: string) {
  return p.split('/').pop() ?? p
}

export function mountTitlebar(root: HTMLElement, store: AppStore, _api: ApiClient): () => void {
  // The structural #titlebar div needs the .titlebar class for its flex layout,
  // height, and traffic-light clearance to apply. Without it the controls
  // collapse and hide under the macOS window buttons.
  root.classList.add('titlebar')

  const leftCluster = el('div', { class: 'titlebar-left' })
  const settingsBtn = el(
    'button',
    { class: 'titlebar-btn titlebar-settings-btn', 'aria-label': 'Settings' },
    'Settings',
  )
  const workspaceName = el('span', { class: 'workspace-name' }, 'No folder')
  leftCluster.append(settingsBtn, workspaceName)

  const dragRegion = el('div', { class: 'titlebar-drag' })
  // Opening projects lives in the projects panel; the titlebar only toggles the
  // file explorer and opens settings.
  const filesBtn = el(
    'button',
    { class: 'titlebar-btn titlebar-text-btn', 'aria-label': 'Toggle right panel' },
    '🗂 Panel',
  )
  const terminalBtn = el(
    'button',
    { class: 'titlebar-btn titlebar-text-btn', 'aria-label': 'Open terminal' },
    '> Terminal',
  )
  const changesBtn = el(
    'button',
    { class: 'titlebar-btn titlebar-text-btn', 'aria-label': 'Open changes' },
    'Changes',
  )

  root.append(leftCluster, dragRegion, filesBtn, terminalBtn, changesBtn)

  filesBtn.addEventListener('click', () => {
    if (!store.getState().workspaceRoot) {
      void addProject(store, _api)
      return
    }
    const open = !store.getState().filesPaneOpen
    store.setState({
      filesPaneOpen: open,
      ...(open ? { rightPanelMode: 'explorer' as const } : {}),
    })
    store.emit('files_pane_changed')
    if (open) store.emit('right_panel_mode_changed')
    syncPanelBtns()
  })

  terminalBtn.addEventListener('click', () => {
    if (!ensureWorkspaceForPanel(_api, store)) return
    store.setState({ filesPaneOpen: true, rightPanelMode: 'terminal' })
    store.emit('files_pane_changed')
    store.emit('right_panel_mode_changed')
    syncPanelBtns()
  })

  changesBtn.addEventListener('click', () => {
    if (!ensureWorkspaceForPanel(_api, store)) return
    store.setState({ filesPaneOpen: true, rightPanelMode: 'changes' })
    store.emit('files_pane_changed')
    store.emit('right_panel_mode_changed')
    syncPanelBtns()
  })

  function syncPanelBtns() {
    const { filesPaneOpen, rightPanelMode } = store.getState()
    filesBtn.classList.toggle('active', filesPaneOpen && rightPanelMode === 'explorer')
    terminalBtn.classList.toggle('active', filesPaneOpen && rightPanelMode === 'terminal')
    changesBtn.classList.toggle('active', filesPaneOpen && rightPanelMode === 'changes')
  }

  function syncName() {
    const r = store.getState().workspaceRoot
    workspaceName.textContent = r ? basename(r) : 'No folder'
  }
  // Titlebar mounts before persisted projects restore on boot; sync on mount
  // for the no-project case, then again when restoreProject emits workspace_changed.
  syncName()
  syncPanelBtns()
  const unsubs = [
    store.on('workspace_changed', syncName),
    store.on('files_pane_changed', syncPanelBtns),
    store.on('right_panel_mode_changed', syncPanelBtns),
  ]

  settingsBtn.addEventListener('click', () => {
    openSettingsDialog()
  })

  return () => unsubs.forEach((u) => u())
}
