import { el, on } from '../dom/helpers.ts'
import { refreshIcon } from '../dom/icons.ts'

/**
 * A small "Retry" button for a failed review/comparison card. Fires `onRetry`
 * once, then disables itself so a double-click can't kick off two runs (the card
 * re-renders into its running state on the next store sync).
 */
export function createRetryButton(onRetry: () => void): HTMLButtonElement {
  const button = el(
    'button',
    { type: 'button', class: 'card-retry-button', title: 'Retry' },
    refreshIcon('ui-icon ui-icon-sm'),
    el('span', {}, 'Retry'),
  )
  on(button, 'click', () => {
    button.disabled = true
    onRetry()
  })
  return button
}
