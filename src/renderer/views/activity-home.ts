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
    // With nothing to list the strip and card would only say so: the screen steps
    // aside and the composer takes the middle of the pane, as a first run always had.
    onIdle: (idle) => {
      root.dataset['idle'] = String(idle)
      pane.classList.toggle('is-activity-idle', idle)
    },
    collapsibleGroups: true,
    projectStrip: true,
    followUrgent: true,
    openThreadArrow: true,
  })

  // The prototype carries no visible heading, summary or status line: the strip
  // already counts what needs you, and a row moves when it is answered. They stay
  // in the page for screen readers (a landmark name and the live region).
  view.status.classList.add('activity-home-sr')
  root.append(
    el('h2', { id: 'activity-home-title', class: 'activity-home-sr' }, 'Activity'),
    view.strip,
    view.body,
    view.status,
    el('p', { class: 'activity-home-caption' }, 'Start a new thread'),
  )
  // Before the composer, which is positioned over the pane's bottom edge.
  pane.insertBefore(root, pane.querySelector('#input-bar'))

  return {
    setShown: (next): void => {
      if (next === shown) return
      shown = next
      root.hidden = !next
      if (!next) pane.classList.remove('is-activity-idle')
      if (next) view.show({ focusFirstRow: false })
      else view.hide()
    },
  }
}
