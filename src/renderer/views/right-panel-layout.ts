import type { AppStore } from '@shared/store/store.ts'
import { isRightPanelMaximized } from '../controller/panels.ts'
import { syncPaneMaximizeButton } from './pane-maximize-button.ts'

/** Set on `#body` while the open pane covers chat (see layout.css). */
export const RIGHT_PANEL_MAXIMIZED_CLASS = 'is-right-panel-maximized'

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
    const isPorts = mode === 'ports'
    const isMemories = mode === 'memories'
    const isRoadmap = mode === 'roadmap'
    const isBrowser = mode === 'browser'

    const treeHost = document.getElementById('file-tree-host')
    const terminalsList = document.getElementById('terminals-list-host')
    const gitChangesHost = document.getElementById('git-changes-host')
    const prListHost = document.getElementById('pr-list-host')
    const portsHost = document.getElementById('ports-host')
    const memoriesHost = document.getElementById('memories-host')
    const roadmapHost = document.getElementById('roadmap-host')
    const browserTabsHost = document.getElementById('browser-tabs-host')
    const treeResizer = document.getElementById('resizer-tree')
    const fileViewer = document.getElementById('file-viewer')
    const terminalsViewer = document.getElementById('terminals-viewer-host')
    const gitDiffViewer = document.getElementById('git-diff-viewer-host')
    const prViewer = document.getElementById('pr-viewer-host')
    const portsViewer = document.getElementById('ports-viewer-host')
    const memoriesViewer = document.getElementById('memories-viewer-host')
    const roadmapViewer = document.getElementById('roadmap-viewer-host')
    const browserViewer = document.getElementById('browser-viewer-host')

    if (treeHost) treeHost.hidden = !isExplorer
    if (terminalsList) terminalsList.hidden = !isTerminal
    if (gitChangesHost) gitChangesHost.hidden = !isChanges
    if (prListHost) prListHost.hidden = !isPrs
    if (portsHost) portsHost.hidden = !isPorts
    if (memoriesHost) memoriesHost.hidden = !isMemories
    if (roadmapHost) roadmapHost.hidden = !isRoadmap
    if (browserTabsHost) browserTabsHost.hidden = !isBrowser
    if (fileViewer) fileViewer.hidden = !isExplorer
    if (terminalsViewer) terminalsViewer.hidden = !isTerminal
    if (gitDiffViewer) gitDiffViewer.hidden = !isChanges
    if (prViewer) prViewer.hidden = !isPrs
    if (portsViewer) portsViewer.hidden = !isPorts
    if (memoriesViewer) memoriesViewer.hidden = !isMemories
    if (roadmapViewer) roadmapViewer.hidden = !isRoadmap
    if (browserViewer) browserViewer.hidden = !isBrowser
    if (treeResizer) treeResizer.hidden = !store.getState().filesPaneOpen
  }

  /**
   * Expanding the panel is a layout state on `#body`, not a per-pane one: only
   * one pane is ever on screen, and every pane header carries the same toggle,
   * so both the class and the buttons' expand/restore face are set from here.
   */
  function syncMaximized(): void {
    const maximized = isRightPanelMaximized(store)
    document.getElementById('body')?.classList.toggle(RIGHT_PANEL_MAXIMIZED_CLASS, maximized)
    for (const btn of document.querySelectorAll<HTMLElement>('.pane-maximize-btn')) {
      syncPaneMaximizeButton(btn, maximized)
    }
    // Chat is covered, not unmounted — it keeps its scroll position and live
    // editors that way, but a composer still holding focus behind the pane would
    // swallow keystrokes meant for the terminal or browser on top of it.
    if (!maximized) return
    const active = document.activeElement
    if (active instanceof HTMLElement && document.getElementById('pane-chat')?.contains(active)) {
      active.blur()
    }
  }

  syncLayout()
  syncMaximized()
  const unsubs = [
    store.on('right_panel_mode_changed', syncLayout),
    store.on('files_pane_changed', syncLayout),
    store.on('files_pane_changed', syncMaximized),
    store.on('right_panel_maximized_changed', syncMaximized),
  ]

  return () => {
    unsubs.forEach((u) => {
      u()
    })
  }
}
