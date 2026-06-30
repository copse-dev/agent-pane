import { el } from '../dom/helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { RightPanelMode } from '@shared/types/state.ts'

/**
 * A small "pop out into its own window" control for a right-panel pane header.
 * Lives inside each pane (not the titlebar) so the affordance sits with the
 * content it detaches; popout.css hides it inside an already-detached window.
 */
export function panePopoutButton(
  api: ApiClient,
  mode: RightPanelMode,
  paneLabel: string,
): HTMLButtonElement {
  const btn = el(
    'button',
    {
      type: 'button',
      class: 'pane-popout-btn',
      'aria-label': `Pop out ${paneLabel}`,
      title: 'Pop out into its own window',
    },
    '⧉',
  )
  btn.addEventListener('click', () => void api.panes.popout(mode))
  return btn
}
