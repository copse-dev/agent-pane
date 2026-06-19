import { el } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { RightPanelMode } from '@shared/types/state.ts'

export function mountRightPanelTabs(root: HTMLElement, store: AppStore): () => void {
  const explorerBtn = el(
    'button',
    {
      type: 'button',
      class: 'right-panel-tab is-active',
      'aria-label': 'Explorer',
    },
    'Explorer',
  )
  const terminalBtn = el(
    'button',
    {
      type: 'button',
      class: 'right-panel-tab',
      'aria-label': 'Terminal',
    },
    'Terminal',
  )
  root.append(explorerBtn, terminalBtn)

  function setMode(mode: RightPanelMode) {
    if (store.getState().rightPanelMode === mode) return
    store.setState({ rightPanelMode: mode, filesPaneOpen: true })
    store.emit('right_panel_mode_changed')
    store.emit('files_pane_changed')
    sync()
    syncLayout()
  }

  function syncLayout() {
    const mode = store.getState().rightPanelMode
    const treeHost = document.getElementById('file-tree-host')
    const treeResizer = document.getElementById('resizer-tree')
    const fileViewer = document.getElementById('file-viewer')
    const terminalHost = document.getElementById('terminal-host')
    const isExplorer = mode === 'explorer'

    if (treeHost) treeHost.hidden = !isExplorer
    if (treeResizer) treeResizer.hidden = !isExplorer
    if (fileViewer) fileViewer.hidden = !isExplorer
    if (terminalHost) terminalHost.hidden = isExplorer
  }

  function sync() {
    const mode = store.getState().rightPanelMode
    explorerBtn.classList.toggle('is-active', mode === 'explorer')
    terminalBtn.classList.toggle('is-active', mode === 'terminal')
    syncLayout()
  }

  explorerBtn.addEventListener('click', () => setMode('explorer'))
  terminalBtn.addEventListener('click', () => setMode('terminal'))

  sync()
  const unsubs = [
    store.on('right_panel_mode_changed', sync),
    store.on('files_pane_changed', syncLayout),
  ]

  return () => unsubs.forEach((u) => u())
}
