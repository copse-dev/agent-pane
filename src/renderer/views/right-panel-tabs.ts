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
  const changesBtn = el(
    'button',
    {
      type: 'button',
      class: 'right-panel-tab',
      'aria-label': 'Changes',
    },
    'Changes',
  )
  root.append(explorerBtn, terminalBtn, changesBtn)

  function syncLayout() {
    const mode = store.getState().rightPanelMode
    const isExplorer = mode === 'explorer'
    const isTerminal = mode === 'terminal'
    const isChanges = mode === 'changes'

    const treeHost = document.getElementById('file-tree-host')
    const terminalsList = document.getElementById('terminals-list-host')
    const gitChangesHost = document.getElementById('git-changes-host')
    const treeResizer = document.getElementById('resizer-tree')
    const fileViewer = document.getElementById('file-viewer')
    const terminalsViewer = document.getElementById('terminals-viewer-host')
    const gitDiffViewer = document.getElementById('git-diff-viewer-host')

    if (treeHost) treeHost.hidden = !isExplorer
    if (terminalsList) terminalsList.hidden = !isTerminal
    if (gitChangesHost) gitChangesHost.hidden = !isChanges
    if (fileViewer) fileViewer.hidden = !isExplorer
    if (terminalsViewer) terminalsViewer.hidden = !isTerminal
    if (gitDiffViewer) gitDiffViewer.hidden = !isChanges
    if (treeResizer) treeResizer.hidden = !store.getState().filesPaneOpen
  }

  function setMode(mode: RightPanelMode) {
    if (store.getState().rightPanelMode === mode) return
    store.setState({ rightPanelMode: mode, filesPaneOpen: true })
    store.emit('right_panel_mode_changed')
    store.emit('files_pane_changed')
    sync()
  }

  function sync() {
    const mode = store.getState().rightPanelMode
    explorerBtn.classList.toggle('is-active', mode === 'explorer')
    terminalBtn.classList.toggle('is-active', mode === 'terminal')
    changesBtn.classList.toggle('is-active', mode === 'changes')
    syncLayout()
  }

  explorerBtn.addEventListener('click', () => setMode('explorer'))
  terminalBtn.addEventListener('click', () => setMode('terminal'))
  changesBtn.addEventListener('click', () => setMode('changes'))

  sync()
  const unsubs = [
    store.on('right_panel_mode_changed', sync),
    store.on('files_pane_changed', syncLayout),
  ]

  return () => unsubs.forEach((u) => u())
}
