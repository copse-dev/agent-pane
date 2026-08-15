import { el } from '../dom/helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { RightPanelMode } from '@shared/types/state.ts'
import { capturePopoutSeed } from '../popout/pane-popout-seed.ts'
import { externalLinkIcon, maximizeIcon } from '../dom/icons.ts'

/**
 * A small "pop out into its own window" control for a right-panel pane header.
 * Lives inside each pane (not the titlebar) so the affordance sits with the
 * content it detaches; popout.css hides it inside an already-detached window.
 */
export function panePopoutButton(
  store: AppStore,
  api: ApiClient,
  mode: RightPanelMode,
  paneLabel: string,
): HTMLButtonElement {
  const browserDemo = document.documentElement.dataset['demoScenario'] !== undefined
  const btn = el(
    'button',
    {
      type: 'button',
      class: 'pane-popout-btn',
      'data-pane-mode': mode,
      'aria-label': browserDemo ? `Expand ${paneLabel}` : `Pop out ${paneLabel}`,
      'data-tooltip': browserDemo
        ? `Expand ${paneLabel}`
        : `Pop out ${paneLabel} into its own window`,
    },
    browserDemo ? maximizeIcon('ui-icon ui-icon-sm') : externalLinkIcon('ui-icon ui-icon-sm'),
  )
  btn.addEventListener('click', () => {
    const seed = capturePopoutSeed(mode, store)
    void api.panes.popout(mode, seed ?? undefined)
  })
  return btn
}
