import { el } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountPanelModeControls } from '../views/panel-mode-controls.ts'

/**
 * Bottom-left panel-mode switcher for a detached pane window. The titlebar and
 * composer portrait row are hidden in pop-out mode, so this bar is the only way
 * to flip between explorer / browser / … without closing the window.
 */
export function mountPopoutPanelBar(
  host: HTMLElement,
  store: AppStore,
  api: ApiClient,
): () => void {
  const wrap = el('div', { class: 'popout-panel-bar-host' })
  const { element, destroy } = mountPanelModeControls(store, api, {
    className: 'popout-panel-bar',
    alwaysShowLabels: 'all',
    enableOverflow: true,
  })
  wrap.append(element)
  host.append(wrap)
  return () => {
    destroy()
    wrap.remove()
  }
}
