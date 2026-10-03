import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { el } from '../dom/helpers.ts'
import {
  createActivityView,
  type ActivityPanelDeps,
  type ActivitySources,
} from './activity-view.ts'

/**
 * The Activity view as the default new-thread screen: it fills the chat pane
 * above the composer while the active thread has no messages, and gives the pane
 * back to the conversation as soon as one arrives
 * (docs/plans/new-thread-activity-screen.md, slice 3).
 *
 * The overlay in `activity-panel.ts` stays; this is a second host for the same
 * view, so it prefixes its element ids to keep them unique on the page.
 */
export interface ActivityHome {
  /** Show or hide the screen; the view draws, and ticks ages, only while shown. */
  setShown: (shown: boolean) => void
}

export function mountActivityHome(
  pane: HTMLElement,
  api: ApiClient,
  store: AppStore,
  sources: ActivitySources,
  deps: ActivityPanelDeps = {},
): ActivityHome {
  let shown = false
  const root = el('section', {
    id: 'activity-home',
    class: 'activity-home',
    'aria-labelledby': 'activity-home-title',
    hidden: '',
  })

  const view = createActivityView(api, store, sources, deps, {
    idPrefix: 'activity-home',
    // Nothing to dismiss: opening a row switches thread, which hides this screen.
    close: () => {},
    isShown: () => shown,
    // Focus belongs to the composer on this screen.
    fallbackFocus: () => {
      pane.querySelector<HTMLElement>('#input-bar .prompt-input')?.focus({ preventScroll: true })
    },
    onNeedsYou: (count) => {
      root.dataset['needsYou'] = String(count)
    },
  })

  root.append(
    el(
      'header',
      { class: 'activity-home-header' },
      el('h2', { id: 'activity-home-title', class: 'activity-home-title' }, 'Activity'),
      view.summary,
      view.status,
    ),
    view.body,
  )
  // Before the composer, which is positioned over the pane's bottom edge.
  pane.insertBefore(root, pane.querySelector('#input-bar'))

  return {
    setShown: (next): void => {
      if (next === shown) return
      shown = next
      root.hidden = !next
      if (next) view.show({ focusFirstRow: false })
      else view.hide()
    },
  }
}
