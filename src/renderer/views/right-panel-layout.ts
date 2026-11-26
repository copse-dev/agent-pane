import { clamp } from '@copse/std/clamp.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { RightPanelMode } from '@shared/types/state.ts'
import {
  isRightPanelMaximized,
  normalizeRightPanelSplit,
  rightPanelSplitOf,
} from '../controller/panels.ts'
import { syncPaneMaximizeButton } from './pane-maximize-button.ts'

/** Set on `#body` while the open pane covers chat (see layout.css). */
export const RIGHT_PANEL_MAXIMIZED_CLASS = 'is-right-panel-maximized'

/** Set on `.pane-files-body` while two panes share the panel (see layout.css). */
export const RIGHT_PANEL_SPLIT_CLASS = 'is-split'

/** The smallest share of the panel's height either half of a split can be dragged to. */
const MIN_SPLIT_SHARE = 0.15

/**
 * Each mode's host elements: its list column (inside `#right-sidebar`) and its
 * viewer. Context also uses `#context-host`, outside the sidebar.
 */
const MODE_HOSTS: Readonly<Record<RightPanelMode, { side: string; view: string }>> = {
  explorer: { side: 'file-tree-host', view: 'file-viewer' },
  context: { side: 'context-host', view: 'context-viewer-host' },
  'side-chat': { side: 'side-chat-host', view: 'side-chat-viewer-host' },
  terminal: { side: 'terminals-list-host', view: 'terminals-viewer-host' },
  changes: { side: 'git-changes-host', view: 'git-diff-viewer-host' },
  prs: { side: 'pr-list-host', view: 'pr-viewer-host' },
  memories: { side: 'memories-host', view: 'memories-viewer-host' },
  roadmap: { side: 'roadmap-host', view: 'roadmap-viewer-host' },
  browser: { side: 'browser-tabs-host', view: 'browser-viewer-host' },
  vnc: { side: 'vnc-controls-host', view: 'vnc-viewer-host' },
}

const MODES: readonly RightPanelMode[] = [
  'explorer',
  'context',
  'side-chat',
  'terminal',
  'changes',
  'prs',
  'memories',
  'roadmap',
  'browser',
  'vnc',
]

// The right panel's section (explorer / terminal / changes / prs / browser) is
// chosen from the titlebar buttons; this controller keeps the matching host
// elements visible for the current `rightPanelMode`, and for the second pane
// stacked beneath it when the panel is split (`rightPanelSplitMode`).
//
// A split never moves a host: the browser's `<webview>` reloads when it is
// reparented. Instead `#right-sidebar` drops out of the box tree
// (`display: contents`) and the body becomes a grid, so each visible host is
// placed in the top or bottom row by its `data-split-slot`.
export function mountRightPanelLayout(store: AppStore): () => void {
  /** Top half's share of the split panel's height. Session-only. */
  let splitShare = 0.5

  function syncLayout(): void {
    const state = store.getState()
    const mode = state.rightPanelMode
    const split = rightPanelSplitOf(state)
    const isContext = mode === 'context'
    const isPrs = mode === 'prs'
    document.getElementById('pane-files')?.classList.toggle('is-context-panel', isContext)

    const sidebar = document.getElementById('right-sidebar')
    if (sidebar) sidebar.hidden = isContext || isPrs

    for (const each of MODES) {
      const hosts = MODE_HOSTS[each]
      const slot = each === mode ? 'primary' : each === split ? 'secondary' : null
      for (const [part, id] of [
        ['side', hosts.side],
        ['view', hosts.view],
      ] as const) {
        const host = document.getElementById(id)
        if (!host) continue
        host.hidden = slot === null
        if (split !== null && slot !== null) {
          host.dataset['splitSlot'] = slot
          host.dataset['splitPart'] = part
        } else {
          delete host.dataset['splitSlot']
          delete host.dataset['splitPart']
        }
      }
    }

    const body = document.querySelector<HTMLElement>('#pane-files .pane-files-body')
    body?.classList.toggle(RIGHT_PANEL_SPLIT_CLASS, split !== null)
    applySplitShare()
    const splitResizer = document.getElementById('resizer-split')
    if (splitResizer) splitResizer.hidden = split === null

    const treeResizer = document.getElementById('resizer-tree')
    if (treeResizer) treeResizer.hidden = isContext || isPrs || !state.filesPaneOpen
  }

  function applySplitShare(): void {
    const body = document.querySelector<HTMLElement>('#pane-files .pane-files-body')
    if (!body) return
    body.style.setProperty('--split-primary', `${String(splitShare)}fr`)
    body.style.setProperty('--split-secondary', `${String(1 - splitShare)}fr`)
  }

  /**
   * Keep the stored pair tidy: a split that the current first pane cannot share
   * (switching to Context, or to the second pane's own mode) is dropped, so it
   * does not silently come back on the next switch.
   */
  function normalizeSplit(): void {
    const { rightPanelMode, rightPanelSplitMode } = store.getState()
    if (rightPanelSplitMode === null) return
    const next = normalizeRightPanelSplit(rightPanelMode, rightPanelSplitMode)
    if (
      next.rightPanelMode === rightPanelMode &&
      next.rightPanelSplitMode === rightPanelSplitMode
    ) {
      return
    }
    store.setState(next)
  }

  function mountSplitResizer(): () => void {
    const handle = document.getElementById('resizer-split')
    const body = document.querySelector<HTMLElement>('#pane-files .pane-files-body')
    if (!handle || !body) return () => {}
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return
      e.preventDefault()
      handle.setPointerCapture(e.pointerId)
      handle.classList.add('is-dragging')
      const rect = body.getBoundingClientRect()
      const onMove = (ev: PointerEvent): void => {
        if (rect.height <= 0) return
        splitShare = clamp(
          (ev.clientY - rect.top) / rect.height,
          MIN_SPLIT_SHARE,
          1 - MIN_SPLIT_SHARE,
        )
        applySplitShare()
      }
      const onUp = (): void => {
        handle.classList.remove('is-dragging')
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
      }
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
    }
    // Keyboard resizing for the separator: arrows move the seam in 5% steps.
    const onKey = (e: KeyboardEvent): void => {
      const step = e.key === 'ArrowUp' ? -0.05 : e.key === 'ArrowDown' ? 0.05 : 0
      if (step === 0) return
      e.preventDefault()
      splitShare = clamp(splitShare + step, MIN_SPLIT_SHARE, 1 - MIN_SPLIT_SHARE)
      applySplitShare()
      handle.setAttribute('aria-valuenow', String(Math.round(splitShare * 100)))
    }
    handle.addEventListener('pointerdown', onDown)
    handle.addEventListener('keydown', onKey)
    return () => {
      handle.removeEventListener('pointerdown', onDown)
      handle.removeEventListener('keydown', onKey)
    }
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

  normalizeSplit()
  syncLayout()
  syncMaximized()
  const unsubs = [
    store.select((s) => s.rightPanelMode, normalizeSplit),
    store.select((s) => s.rightPanelSplitMode, normalizeSplit),
    store.select((s) => s.rightPanelMode, syncLayout),
    store.select((s) => s.rightPanelSplitMode, syncLayout),
    store.select((s) => s.filesPaneOpen, syncLayout),
    store.select(() => isRightPanelMaximized(store), syncMaximized),
    mountSplitResizer(),
  ]

  return () => {
    unsubs.forEach((u) => {
      u()
    })
  }
}
