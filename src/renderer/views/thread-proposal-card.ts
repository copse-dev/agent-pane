import { el } from '../dom/helpers.ts'
import { arrowRightIcon, checkIcon, closeIcon, gitBranchIcon } from '../dom/icons.ts'
import {
  threadProposalFileSummary,
  type ThreadProposal,
  type ThreadProposalStatus,
} from '@shared/threads/thread-proposal.ts'

/**
 * The card for a model-proposed thread.
 *
 * This is an **offer**, not a permission prompt, and the whole design follows
 * from that: it sits in the transcript instead of over it, nothing is disabled
 * behind it, and leaving it alone forever is a valid answer. A modal here would
 * be a lie — it would interrupt the user to ask about work that is not running,
 * was not requested, and costs nothing to ignore. So the card reads as a
 * suggestion card: what the run would do first, in prose the user can judge
 * without reading a prompt, with the prompt itself one disclosure away.
 *
 * The two resolved states stay in place rather than vanishing. A started
 * proposal keeps a link to the thread it made (the transcript is where the user
 * will look for it later); a dismissed one collapses to a single quiet line with
 * an undo, because "not now" is usually about timing, not about the idea.
 */

export interface ThreadProposalCardHandlers {
  /** Create and start the thread. Resolves once the new thread exists. */
  onStart: (proposal: ThreadProposal) => Promise<void>
  onDismiss: (proposal: ThreadProposal) => void
  /** Return a dismissed proposal to its standing-offer state. */
  onRestore: (proposal: ThreadProposal) => void
  /** Open the thread a started proposal created; absent while none exists. */
  onOpenThread: (threadId: string) => void
}

export interface ThreadProposalCardState {
  status: ThreadProposalStatus
  /** Thread created by a `started` proposal, when it still exists. */
  threadId?: string
}

function chip(kind: string, ...children: (Node | string)[]): HTMLElement {
  return el('span', { class: 'thread-proposal-chip', 'data-chip': kind }, ...children)
}

function statePill(status: ThreadProposalStatus): HTMLElement | null {
  if (status === 'started') {
    return el(
      'span',
      { class: 'thread-proposal-state', 'data-state': 'started' },
      checkIcon('ui-icon ui-icon-sm'),
      'Thread started',
    )
  }
  if (status === 'dismissed') {
    return el(
      'span',
      { class: 'thread-proposal-state', 'data-state': 'dismissed' },
      closeIcon('ui-icon ui-icon-sm'),
      'Dismissed',
    )
  }
  return null
}

/**
 * The way back to a thread this card started. It lives in the header, not the
 * body, because a settled card is collapsed: the one thing the user will want
 * from it later — "take me to that work" — must not be behind a disclosure.
 */
function buildOpenThreadButton(
  threadId: string,
  handlers: ThreadProposalCardHandlers,
): HTMLButtonElement {
  const open = el(
    'button',
    { type: 'button', class: 'thread-proposal-open' },
    'Open thread',
    arrowRightIcon('ui-icon ui-icon-sm'),
  )
  open.addEventListener('click', (event) => {
    // The button sits inside the card's <summary>; without this, opening the
    // thread would also toggle the disclosure it is leaving behind.
    event.preventDefault()
    event.stopPropagation()
    handlers.onOpenThread(threadId)
  })
  return open
}

function buildPendingActions(
  proposal: ThreadProposal,
  handlers: ThreadProposalCardHandlers,
  rerender: (next: ThreadProposalCardState) => void,
): HTMLElement {
  const start = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-primary thread-proposal-start' },
    'Start this thread',
  )
  const dismiss = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-secondary thread-proposal-dismiss' },
    'Not now',
  )
  const error = el('span', { class: 'thread-proposal-error', role: 'alert', hidden: '' })

  start.addEventListener('click', () => {
    start.disabled = true
    dismiss.disabled = true
    start.textContent = 'Starting…'
    error.hidden = true
    void handlers.onStart(proposal).catch((cause: unknown) => {
      // The offer survives its own failure: re-enable rather than resolving the
      // card, so a failed checkout does not silently consume the proposal.
      start.disabled = false
      dismiss.disabled = false
      start.textContent = 'Start this thread'
      error.textContent =
        cause instanceof Error
          ? `Could not start the thread: ${cause.message}`
          : 'Could not start the thread.'
      error.hidden = false
    })
  })
  dismiss.addEventListener('click', () => {
    handlers.onDismiss(proposal)
    rerender({ status: 'dismissed' })
  })

  return el('div', { class: 'thread-proposal-actions' }, start, dismiss, error)
}

function buildDismissedActions(
  proposal: ThreadProposal,
  handlers: ThreadProposalCardHandlers,
  rerender: (next: ThreadProposalCardState) => void,
): HTMLElement {
  const restore = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-ghost thread-proposal-restore' },
    'Bring it back',
  )
  restore.addEventListener('click', () => {
    handlers.onRestore(proposal)
    rerender({ status: 'pending' })
  })
  return el('div', { class: 'thread-proposal-actions' }, restore)
}

function buildBody(
  proposal: ThreadProposal,
  state: ThreadProposalCardState,
  handlers: ThreadProposalCardHandlers,
  rerender: (next: ThreadProposalCardState) => void,
): HTMLElement {
  const body = el('div', { class: 'thread-proposal-body' })
  body.append(el('h4', { class: 'thread-proposal-title' }, proposal.title))

  // The description the user actually judges the offer on. Deliberately the
  // largest block on the card and always visible — the prompt below it is
  // machine text and stays folded away.
  body.append(el('p', { class: 'thread-proposal-summary' }, proposal.summary))
  if (proposal.rationale) {
    body.append(el('p', { class: 'thread-proposal-rationale' }, proposal.rationale))
  }

  const chips = el('div', { class: 'thread-proposal-chips' })
  chips.append(chip('worktree', gitBranchIcon('ui-icon ui-icon-sm'), 'Its own checkout'))
  const files = threadProposalFileSummary(proposal.files)
  if (files) chips.append(chip('files', files))
  body.append(chips)

  const prompt = el('details', { class: 'thread-proposal-prompt' })
  prompt.append(
    el('summary', { class: 'thread-proposal-prompt-summary' }, 'The prompt it would start with'),
    el('pre', { class: 'thread-proposal-prompt-text' }, proposal.prompt),
  )
  body.append(prompt)

  if (state.status === 'pending') {
    body.append(buildPendingActions(proposal, handlers, rerender))
  } else if (state.status === 'dismissed') {
    body.append(buildDismissedActions(proposal, handlers, rerender))
  }
  // A started card carries no action of its own — the way back to its thread is
  // in the header, where the collapsed row can reach it.
  return body
}

/**
 * Build the card. `state` is read once here — the buttons then drive the DOM
 * directly, and a later rebuild (thread switch, reload) reads the store again.
 */
export function createThreadProposalCard(
  proposal: ThreadProposal,
  state: ThreadProposalCardState,
  handlers: ThreadProposalCardHandlers,
): HTMLDetailsElement {
  const card = el('details', {
    class: 'tool-card thread-proposal',
    'data-tool-id': proposal.id,
    'data-status': 'done',
  })

  const render = (next: ThreadProposalCardState): void => {
    while (card.firstChild) card.firstChild.remove()
    card.dataset['proposalStatus'] = next.status
    // Only a standing offer opens itself. A resolved card is history: it stays
    // in place, one line tall, and expands if the user wants the detail back.
    card.open = next.status === 'pending'

    const header = el(
      'summary',
      { class: 'tool-card-header thread-proposal-header' },
      el(
        'span',
        { class: 'thread-proposal-icon', 'aria-hidden': 'true' },
        gitBranchIcon('ui-icon ui-icon-sm'),
      ),
      el('span', { class: 'thread-proposal-eyebrow' }, 'Proposed thread'),
      el('span', { class: 'thread-proposal-header-title' }, proposal.title),
    )
    const pill = statePill(next.status)
    if (pill) header.append(pill)
    if (next.status === 'started' && next.threadId) {
      header.append(buildOpenThreadButton(next.threadId, handlers))
    }
    card.append(header, buildBody(proposal, next, handlers, render))
  }

  render(state)
  return card
}
