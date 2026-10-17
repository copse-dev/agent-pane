// The footer under a finished concise turn: the one place the view admits it
// hid something. It states what a user Stop left unsaid (the tool card that
// carried the note is hidden) and opens the turn in full — tool cards, diffs,
// terminals, reasoning — and closes it again.

import { el } from '../dom/helpers.ts'
import { interruptionNote } from './turn-interruption.ts'
import type { ConciseTurnSummary } from './concise-thread.ts'

export const CONCISE_TURN_FOOTER_CLASS = 'concise-turn-footer'

function toolCallCountLabel(count: number): string {
  return count === 0 ? '' : `${String(count)} tool ${count === 1 ? 'call' : 'calls'}`
}

/** A footer for `summary`; `onToggle` flips the turn between concise and full. */
export function createConciseTurnFooter(
  summary: ConciseTurnSummary,
  expanded: boolean,
  onToggle: () => void,
): HTMLElement {
  const note = el('span', { class: 'concise-turn-note' })
  const label = el('span', { class: 'concise-turn-toggle-label' })
  const count = el('span', { class: 'concise-turn-count' })
  const edits = el(
    'span',
    { class: 'concise-turn-edits' },
    el('span', { class: 'concise-turn-added' }),
    el('span', { class: 'concise-turn-deleted' }),
  )
  const toggle = el('button', { type: 'button', class: 'concise-turn-toggle' })
  toggle.append(label, count, edits)
  toggle.addEventListener('click', onToggle)
  const footer = el('div', { class: CONCISE_TURN_FOOTER_CLASS })
  footer.append(note, toggle)
  updateConciseTurnFooter(footer, summary, expanded)
  return footer
}

/** Bring an existing footer up to date in place, so a focused toggle keeps focus. */
export function updateConciseTurnFooter(
  footer: HTMLElement,
  summary: ConciseTurnSummary,
  expanded: boolean,
): void {
  footer.dataset['conciseTurnFor'] = summary.startId
  const note = footer.querySelector<HTMLElement>('.concise-turn-note')
  const toggle = footer.querySelector<HTMLButtonElement>('.concise-turn-toggle')
  const label = footer.querySelector<HTMLElement>('.concise-turn-toggle-label')
  const count = footer.querySelector<HTMLElement>('.concise-turn-count')
  const edits = footer.querySelector<HTMLElement>('.concise-turn-edits')
  const added = edits?.querySelector<HTMLElement>('.concise-turn-added')
  const deleted = edits?.querySelector<HTMLElement>('.concise-turn-deleted')
  if (!note || !toggle || !label || !count || !edits || !added || !deleted) return
  const noteText = summary.interruption === null ? '' : interruptionNote(summary.interruption)
  note.textContent = noteText
  note.hidden = noteText === ''
  // A stopped turn that did no work has nothing to open.
  toggle.hidden = !summary.hasHiddenSteps
  label.textContent = expanded ? 'Hide steps' : 'Show steps'
  count.textContent = toolCallCountLabel(summary.toolCallCount)
  count.hidden = count.textContent === ''
  // What the edits came to: the one fact about hidden work a reader needs unasked.
  edits.hidden = summary.edits === null
  added.textContent = summary.edits ? `+${String(summary.edits.additions)}` : ''
  deleted.textContent = summary.edits ? `−${String(summary.edits.deletions)}` : ''
  toggle.setAttribute('aria-expanded', String(expanded))
}
