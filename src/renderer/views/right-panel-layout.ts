import type { AppStore } from '@shared/store/store.ts'

// The right panel's section (explorer / terminal / changes / prs / browser) is
// chosen from the titlebar buttons; this controller just keeps the matching host
// elements visible for the current `rightPanelMode`.
export function mountRightPanelLayout(store: AppStore): () => void {
  function syncLayout(): void {
    const mode = store.getState().rightPanelMode
    const isExplorer = mode === 'explorer'
    const isTerminal = mode === 'terminal'
    const isChanges = mode === 'changes'
    const isPrs = mode === 'prs'
    const isBrowser = mode === 'browser'

    const treeHost = document.getElementById('file-tree-host')
    const terminalsList = document.getElementById('terminals-list-host')
    const gitChangesHost = document.getElementById('git-changes-host')
    const prListHost = document.getElementById('pr-list-host')
    const browserTabsHost = document.getElementById('browser-tabs-host')
    const treeResizer = document.getElementById('resizer-tree')
    const fileViewer = document.getElementById('file-viewer')
    const terminalsViewer = document.getElementById('terminals-viewer-host')
    const gitDiffViewer = document.getElementById('git-diff-viewer-host')
    const prViewer = document.getElementById('pr-viewer-host')
    const browserViewer = document.getElementById('browser-viewer-host')

    if (treeHost) treeHost.hidden = !isExplorer
    if (terminalsList) terminalsList.hidden = !isTerminal
    if (gitChangesHost) gitChangesHost.hidden = !isChanges
    if (prListHost) prListHost.hidden = !isPrs
    if (browserTabsHost) browserTabsHost.hidden = !isBrowser
    if (fileViewer) fileViewer.hidden = !isExplorer
    if (terminalsViewer) terminalsViewer.hidden = !isTerminal
    if (gitDiffViewer) gitDiffViewer.hidden = !isChanges
    if (prViewer) prViewer.hidden = !isPrs
    if (browserViewer) browserViewer.hidden = !isBrowser
    if (treeResizer) treeResizer.hidden = !store.getState().filesPaneOpen
  }

  syncLayout()
  const unsubs = [
    store.on('right_panel_mode_changed', syncLayout),
    store.on('files_pane_changed', syncLayout),
  ]

  return () => {
    unsubs.forEach((u) => {
      u()
    })
  }
}
