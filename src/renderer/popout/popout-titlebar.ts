import { el } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountPanelModeControls, panelModeLabel } from '../views/panel-mode-controls.ts'

/**
 * Titlebar for a detached pane window. The pop-out is frameless like the main
 * window, so this bar supplies both the window title and the panel-mode
 * switcher — without it there is no way to flip between explorer / browser / …
 * and no title at all, since the app's own #titlebar stays hidden in pop-outs.
 */
export function mountPopoutTitlebar(
  host: HTMLElement,
  store: AppStore,
  api: ApiClient,
): () => void {
  const bar = el('div', { class: 'titlebar popout-titlebar' })
  const title = el('span', { class: 'popout-titlebar-title' })
  // Same container class as the main titlebar's cluster so the buttons inherit
  // its transparent/hover/active treatment rather than a second look-alike set.
  const { element, destroy } = mountPanelModeControls(store, api, {
    className: 'titlebar-panel-controls popout-panel-bar',
    alwaysShowLabels: 'all',
    enableOverflow: true,
  })
  bar.append(title, element)
  host.prepend(bar)

  function syncTitle(): void {
    title.textContent = panelModeLabel(store.getState().rightPanelMode)
  }
  syncTitle()
  const unsub = store.on('right_panel_mode_changed', syncTitle)

  return () => {
    unsub()
    destroy()
    bar.remove()
  }
}
