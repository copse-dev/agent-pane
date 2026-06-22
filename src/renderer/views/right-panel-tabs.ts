import { el } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import { getActiveThread } from '@shared/store/thread-helpers.ts'
import { mountPlanPane } from './todo-panel.ts'

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
  const planBtn = el(
    'button',
    {
      type: 'button',
      class: 'right-panel-tab',
      'aria-label': 'Plan',
    },
    'Plan',
  )
  root.append(explorerBtn, terminalBtn, changesBtn, planBtn)

  let renderPlanPane: (() => void) | null = null
  const planHost = document.getElementById('plan-viewer-host')
  if (planHost) {
    renderPlanPane = mountPlanPane(planHost, () => {
      const thread = getActiveThread(store)
      return thread?.todos
    })
  }

  function syncLayout() {
    const mode = store.getState().rightPanelMode
    const isExplorer = mode === 'explorer'
    const isTerminal = mode === 'terminal'
    const isChanges = mode === 'changes'
    const isPlan = mode === 'plan'

    const treeHost = document.getElementById('file-tree-host')
    const terminalsList = document.getElementById('terminals-list-host')
    const gitChangesHost = document.getElementById('git-changes-host')
    const treeResizer = document.getElementById('resizer-tree')
    const fileViewer = document.getElementById('file-viewer')
    const planViewer = document.getElementById('plan-viewer-host')
    const terminalsViewer = document.getElementById('terminals-viewer-host')
    const gitDiffViewer = document.getElementById('git-diff-viewer-host')

    if (treeHost) treeHost.hidden = !isExplorer
    if (terminalsList) terminalsList.hidden = !isTerminal
    if (gitChangesHost) gitChangesHost.hidden = !isChanges
    if (fileViewer) fileViewer.hidden = !isExplorer
    if (planViewer) planViewer.hidden = !isPlan
    if (terminalsViewer) terminalsViewer.hidden = !isTerminal
    if (gitDiffViewer) gitDiffViewer.hidden = !isChanges
    if (treeResizer) treeResizer.hidden = !store.getState().filesPaneOpen || isPlan
    if (isPlan) renderPlanPane?.()
  }

  function setMode(mode: import('@shared/types/state.ts').RightPanelMode) {
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
    planBtn.classList.toggle('is-active', mode === 'plan')
    syncLayout()
  }

  explorerBtn.addEventListener('click', () => setMode('explorer'))
  terminalBtn.addEventListener('click', () => setMode('terminal'))
  changesBtn.addEventListener('click', () => setMode('changes'))
  planBtn.addEventListener('click', () => setMode('plan'))

  sync()
  const unsubs = [
    store.on('right_panel_mode_changed', sync),
    store.on('files_pane_changed', syncLayout),
    store.on('todos_changed', () => {
      if (store.getState().rightPanelMode === 'plan') renderPlanPane?.()
    }),
    store.on('threads_changed', () => {
      if (store.getState().rightPanelMode === 'plan') renderPlanPane?.()
    }),
  ]

  return () => unsubs.forEach((u) => u())
}
