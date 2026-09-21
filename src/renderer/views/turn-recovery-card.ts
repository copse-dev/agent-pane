import { el } from '../dom/helpers.ts'
import { refreshIcon, warningIcon } from '../dom/icons.ts'

export interface TurnRecoveryCardOptions {
  lastKnownGoodLabel?: string
  onRetry: () => boolean
  onRetryWithLastKnownGood?: () => boolean
}

/** Visible, human-triggered continuation offer for an interrupted turn. */
export function createTurnRecoveryCard(options: TurnRecoveryCardOptions): HTMLElement {
  const actions = el('div', { class: 'turn-recovery-actions' })
  const buttons: HTMLButtonElement[] = []
  const action = (label: string, callback: () => boolean): HTMLButtonElement => {
    const button = el(
      'button',
      { class: 'ui-btn ui-btn-secondary turn-recovery-button', type: 'button' },
      refreshIcon('ui-icon ui-icon-sm'),
      el('span', {}, label),
    )
    button.addEventListener('click', () => {
      buttons.forEach((candidate) => (candidate.disabled = true))
      if (callback()) button.closest('.turn-recovery-card')?.remove()
      else buttons.forEach((candidate) => (candidate.disabled = false))
    })
    buttons.push(button)
    actions.append(button)
    return button
  }

  action('Retry this turn', options.onRetry)
  if (options.lastKnownGoodLabel !== undefined && options.onRetryWithLastKnownGood !== undefined) {
    action(`Use ${options.lastKnownGoodLabel} and retry`, options.onRetryWithLastKnownGood)
  }

  const body = el(
    'div',
    { class: 'turn-recovery-body' },
    el('div', { class: 'turn-recovery-title' }, 'Turn interrupted'),
    el(
      'div',
      { class: 'turn-recovery-detail' },
      'Continue from the saved progress. Completed tool calls stay in the history and are not replayed automatically.',
    ),
  )
  if (options.lastKnownGoodLabel !== undefined) {
    body.append(
      el(
        'div',
        { class: 'turn-recovery-model-note' },
        `An earlier turn completed with ${options.lastKnownGoodLabel}.`,
      ),
    )
  }

  return el(
    'section',
    {
      class: 'turn-recovery-card',
      'data-turn-recovery-card': '',
      'aria-label': 'Interrupted turn recovery',
    },
    el(
      'span',
      { class: 'turn-recovery-icon', 'aria-hidden': 'true' },
      warningIcon('ui-icon ui-icon-sm'),
    ),
    body,
    actions,
  )
}
