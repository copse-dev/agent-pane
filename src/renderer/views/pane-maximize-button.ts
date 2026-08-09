import { el } from '../dom/helpers.ts'
import { maximizeIcon, minimizeIcon } from '../dom/icons.ts'
import type { AppStore } from '@shared/store/store.ts'
import { isRightPanelMaximized, toggleRightPanelMaximized } from '../controller/panels.ts'

/**
 * "Expand this pane over chat" toggle for a right-panel pane header. Sits beside
 * the pop-out control because the two are the same family of affordance — pop
 * out detaches the pane into its own window, expand gives it the whole of this
 * one — and because the pane header is the only chrome still on screen once the
 * pane covers chat, so the way back sits exactly where the way in was.
 *
 * The button is a toggle, not a pair: {@link syncPaneMaximizeButton} flips its
 * icon and label to "restore" while the panel is expanded. Buttons are re-labeled
 * centrally (see `mountRightPanelLayout`) rather than each subscribing to the
 * store, so every pane header stays in step from one listener.
 */
export function paneMaximizeButton(store: AppStore, paneLabel: string): HTMLButtonElement {
  const btn = el('button', {
    type: 'button',
    class: 'pane-maximize-btn',
    'data-pane-label': paneLabel,
  })
  // Panes mount at different times (Changes and PRs wait on Monaco), so a button
  // created while the panel is already expanded starts on the restore face.
  syncPaneMaximizeButton(btn, isRightPanelMaximized(store))
  btn.addEventListener('click', () => {
    toggleRightPanelMaximized(store)
  })
  return btn
}

/** Point an expand button at the state it currently toggles *away from*. */
export function syncPaneMaximizeButton(btn: HTMLElement, maximized: boolean): void {
  const label = btn.dataset['paneLabel'] ?? 'panel'
  btn.replaceChildren(
    maximized ? minimizeIcon('ui-icon ui-icon-sm') : maximizeIcon('ui-icon ui-icon-sm'),
  )
  btn.setAttribute('aria-label', maximized ? `Restore ${label}` : `Expand ${label} over chat`)
  btn.setAttribute('aria-pressed', String(maximized))
  btn.title = maximized ? 'Restore panel size' : 'Expand over chat'
}
