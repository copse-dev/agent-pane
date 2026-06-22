import { el } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { materialIconUrl, mountMaterialIcon } from '../icons/material-file-icons.ts'
import { openSettingsDialog } from './settings-dialog.ts'
import { openRightPanelWithWorkspace, toggleFilesPaneWithWorkspace } from '../controller/panels.ts'

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
  const filesBtnIcon = el('span', { class: 'titlebar-btn-icon' })
  mountMaterialIcon(filesBtnIcon, materialIconUrl('folder'), 'Explorer')
  const filesBtn = el(
    'button',
    { class: 'titlebar-btn titlebar-text-btn', 'aria-label': 'Toggle right panel' },
    filesBtnIcon,
    'Panel',
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
    toggleFilesPaneWithWorkspace(store, _api)
    syncPanelBtns()
  })

  terminalBtn.addEventListener('click', () => {
    openRightPanelWithWorkspace(store, _api, 'terminal')
    syncPanelBtns()
  })

  changesBtn.addEventListener('click', () => {
    openRightPanelWithWorkspace(store, _api, 'changes')
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
