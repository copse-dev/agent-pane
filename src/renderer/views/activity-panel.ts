import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { el } from '../dom/helpers.ts'
import { closeIcon } from '../dom/icons.ts'
import {
  createActivityView,
  type ActivityPanelDeps,
  type ActivitySources,
} from './activity-view.ts'
import { createOverlayDialog } from './dialog-shell.ts'

export { ACTIVITY_AGE_REFRESH_MS, ACTIVITY_RENDER_INTERVAL_MS } from './activity-view.ts'
export type { ActivityPanelDeps, ActivitySources } from './activity-view.ts'

/**
 * The Activity panel (docs/plans/mission-control.md, slice 1): the Activity view
 * in one overlay, reachable from anywhere. The view itself — rows, detail pane,
 * in-place approval — lives in `activity-view.ts`; this file only owns the
 * dialog around it.
 */

export interface ActivityPanel {
  open: () => void
  close: () => void
  isOpen: () => boolean
}

let openActive: (() => void) | null = null

/** Open the mounted Activity panel (sidebar bell, command palette, shortcut). */
export function openActivityPanel(): void {
  openActive?.()
}

export function mountActivityPanel(
  api: ApiClient,
  store: AppStore,
  sources: ActivitySources,
  deps: ActivityPanelDeps = {},
): ActivityPanel {
  const { dialog, open, close, isOpen } = createOverlayDialog({
    id: 'activity-panel',
    className: 'activity-panel-overlay',
  })
  dialog.setAttribute('aria-labelledby', 'activity-panel-title')
  dialog.setAttribute('aria-describedby', 'activity-panel-summary')

  const closeButton = el(
    'button',
    {
      type: 'button',
      class: 'ui-btn ui-btn-ghost activity-panel-close',
      'aria-label': 'Close activity',
    },
    closeIcon(),
  )
  closeButton.addEventListener('click', close)

  const view = createActivityView(api, store, sources, deps, {
    idPrefix: 'activity-panel',
    close,
    isShown: isOpen,
    fallbackFocus: () => {
      closeButton.focus()
    },
    onNeedsYou: (count) => {
      dialog.dataset['needsYou'] = String(count)
    },
  })

  dialog.append(
    el(
      'div',
      { class: 'activity-panel-shell' },
      el(
        'header',
        { class: 'activity-panel-header' },
        el('h2', { id: 'activity-panel-title' }, 'Activity'),
        view.summary,
        closeButton,
      ),
      view.body,
      el(
        'footer',
        { class: 'activity-panel-footer' },
        el('span', {}, '↑ ↓ choose · Tab to act · Esc closes'),
        view.status,
      ),
    ),
  )

  dialog.addEventListener('close', view.hide)

  const panel: ActivityPanel = {
    open: () => {
      if (isOpen()) return
      open()
      view.show()
    },
    close,
    isOpen,
  }
  openActive = panel.open
  return panel
}
