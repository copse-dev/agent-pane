import { el } from '../dom/helpers.ts'
import { outlineIcon } from '../dom/outline-icon.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { toggleRightPanelWithWorkspace } from '../controller/panels.ts'

function basename(p: string) {
  return p.split('/').pop() ?? p
}

function panelIcon(): SVGSVGElement {
  return outlineIcon(
    'panel',
    ['M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z', 'M9 4v16'],
    'titlebar-btn-icon',
  )
}

function terminalIcon(): SVGSVGElement {
  return outlineIcon('terminal', ['m7 8 4 4-4 4', 'M13 16h4'], 'titlebar-btn-icon')
}

function changesIcon(): SVGSVGElement {
  return outlineIcon(
    'changes',
    [
      'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
      'M6 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
      'M15 5H9a3 3 0 0 0-3 3v8',
      'M9 19h6a3 3 0 0 0 3-3V8',
    ],
    'titlebar-btn-icon',
  )
}

function browserIcon(): SVGSVGElement {
  return outlineIcon(
    'browser',
    [
      'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z',
      'M2 12h20',
      'M12 2a15.3 15.3 0 0 1 0 20 15.3 15.3 0 0 1 0-20Z',
    ],
    'titlebar-btn-icon',
  )
}

export function mountTitlebar(root: HTMLElement, store: AppStore, _api: ApiClient): () => void {
  // The structural #titlebar div needs the .titlebar class for its flex layout,
  // height, and traffic-light clearance to apply. Without it the controls
  // collapse and hide under the macOS window buttons.
  root.classList.add('titlebar')

  const leftCluster = el('div', { class: 'titlebar-left' })
  const workspaceName = el('span', { class: 'workspace-name' }, 'No folder')
  leftCluster.append(workspaceName)

  const dragRegion = el('div', { class: 'titlebar-drag' })
  // Opening projects lives in the projects panel; the titlebar only toggles the
  // file explorer and opens settings.
  const filesBtn = el(
    'button',
    { class: 'titlebar-btn titlebar-text-btn', 'aria-label': 'Toggle right panel' },
    panelIcon(),
    'Panel',
  )
  const terminalBtn = el(
    'button',
    { class: 'titlebar-btn titlebar-text-btn', 'aria-label': 'Open terminal' },
    terminalIcon(),
    'Terminal',
  )
  const changesBtn = el(
    'button',
    { class: 'titlebar-btn titlebar-text-btn', 'aria-label': 'Open changes' },
    changesIcon(),
    'Changes',
  )
  const browserBtn = el(
    'button',
    { class: 'titlebar-btn titlebar-text-btn', 'aria-label': 'Open browser' },
    browserIcon(),
    'Browser',
  )
  const panelControls = el(
    'div',
    { class: 'titlebar-panel-controls' },
    filesBtn,
    terminalBtn,
    changesBtn,
    browserBtn,
  )

  root.append(leftCluster, dragRegion, panelControls)

  filesBtn.addEventListener('click', () => {
    toggleRightPanelWithWorkspace(store, _api, 'explorer')
    syncPanelBtns()
  })

  terminalBtn.addEventListener('click', () => {
    toggleRightPanelWithWorkspace(store, _api, 'terminal')
    syncPanelBtns()
  })

  changesBtn.addEventListener('click', () => {
    toggleRightPanelWithWorkspace(store, _api, 'changes')
    syncPanelBtns()
  })

  browserBtn.addEventListener('click', () => {
    toggleRightPanelWithWorkspace(store, _api, 'browser')
    syncPanelBtns()
  })

  function syncPanelBtns() {
    const { filesPaneOpen, rightPanelMode } = store.getState()
    filesBtn.classList.toggle('active', filesPaneOpen && rightPanelMode === 'explorer')
    terminalBtn.classList.toggle('active', filesPaneOpen && rightPanelMode === 'terminal')
    changesBtn.classList.toggle('active', filesPaneOpen && rightPanelMode === 'changes')
    browserBtn.classList.toggle('active', filesPaneOpen && rightPanelMode === 'browser')
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

  return () => unsubs.forEach((u) => u())
}
