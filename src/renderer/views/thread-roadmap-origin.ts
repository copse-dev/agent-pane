import { el } from '../dom/helpers.ts'
import { outlineIcon } from '../dom/outline-icon.ts'
import { navigateToRoadmapItem } from '../controller/panels.ts'
import { setTooltip } from '../dom/tooltip.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'

function roadmapOriginIcon(): SVGSVGElement {
  // Same glyph as the Roadmap panel toggle (panel-mode-controls.ts) so the
  // "this leads to the roadmap" meaning is consistent in both directions.
  return outlineIcon(
    'roadmap',
    ['M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4Z', 'M8 2v16', 'M16 6v16'],
    'thread-roadmap-origin-icon',
  )
}

/**
 * Back-link chip shown above the transcript when the active thread was
 * started from a roadmap item ("Start thread" in the Roadmap pane stamps the
 * item's `thread` field — see `startThread` in roadmap-pane.ts). Clicking it
 * opens the Roadmap pane with that item selected, the reverse of the
 * `.roadmap-thread-chip` the item's own row shows to jump *to* the thread.
 *
 * Hidden for any thread with no roadmap origin (the common case), and for a
 * thread whose item has since been superseded — the item's `thread` field
 * only ever holds the *most recently started* thread (restamped on every
 * "Start thread"), so if two threads were started from the same item, only
 * the newer one keeps this link; the older thread quietly stops showing it
 * rather than pointing at the wrong item.
 */
export function mountThreadRoadmapOrigin(
  store: AppStore,
  api: ApiClient,
): { element: HTMLElement; destroy: () => void } {
  const titleEl = el('span', { class: 'thread-roadmap-origin-title' })
  const link = el(
    'button',
    { type: 'button', class: 'thread-roadmap-origin', hidden: true },
    roadmapOriginIcon(),
    titleEl,
  )

  let itemId: string | null = null
  let generation = 0
  // The thread the last lookup was for. `threads_changed` fires many times per
  // turn (streaming, titles, status), and each lookup reads every roadmap note
  // on the main side, so thread events only re-query when the active thread
  // actually changed; `roadmap:changed` always re-queries.
  let syncedThreadId: string | null | undefined

  function syncIfThreadChanged(): void {
    if (store.getState().activeThreadId !== syncedThreadId) sync()
  }

  function sync(): void {
    const gen = ++generation
    const threadId = store.getState().activeThreadId
    const threadChanged = threadId !== syncedThreadId
    syncedThreadId = threadId
    if (!threadId) {
      itemId = null
      link.hidden = true
      return
    }
    // A lookup reads the roadmap store on the main side. Hide and disarm the
    // previous thread's chip while that read is in flight, so a quick click
    // after switching threads can never navigate to the old thread's origin.
    if (threadChanged) {
      itemId = null
      link.hidden = true
    }
    void api.roadmap
      .findByThread(threadId)
      .then((item) => {
        if (gen !== generation) return
        if (!item) {
          itemId = null
          link.hidden = true
          return
        }
        itemId = item.id
        const title = item.title || '(untitled)'
        titleEl.textContent = title
        setTooltip(link, `Open roadmap item "${title}"`)
        link.setAttribute('aria-label', `Open roadmap item "${title}"`)
        link.hidden = false
      })
      .catch(() => {
        if (gen !== generation) return
        itemId = null
        link.hidden = true
      })
  }

  link.addEventListener('click', () => {
    if (itemId) navigateToRoadmapItem(store, itemId)
  })

  sync()
  const unsubscribeThreads = store.on('threads_changed', syncIfThreadChanged)
  // "Start thread" creates the thread (threads_changed) before the item's
  // `thread` field is stamped — the pane's setThread call returns and
  // broadcasts on this same channel once it durably lands (see
  // roadmap:set-thread), the same shape as a background complexity stamp.
  // Renames and deletes broadcast on it too, so the chip never keeps a stale
  // title or a link to a deleted item.
  const unsubscribeRoadmap = api.roadmap.onChanged(sync)

  return {
    element: link,
    destroy: (): void => {
      generation++
      unsubscribeThreads()
      unsubscribeRoadmap()
    },
  }
}
