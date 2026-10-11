import { el } from '../dom/helpers.ts'
import { chevronRightIcon } from '../dom/icons.ts'
import type { PrThreadRelationship } from '@shared/git/thread-pr-relations.ts'

export interface PrThreadRelationshipsView {
  /** Whether the related threads are open. Defaults to closed when a producer exists. */
  expanded?: boolean | undefined
  onToggle?: (expanded: boolean) => void
}

function threadChip(
  row: PrThreadRelationship,
  kind: 'produced' | 'related',
  openThread: (id: string) => void,
): HTMLButtonElement {
  const kindLabel = row.kinds.includes('agent-linked') ? 'Agent-linked' : 'Referenced PR'
  const button = el(
    'button',
    {
      type: 'button',
      class: 'pr-open-thread-btn pr-thread-link',
      'data-thread-id': row.threadId,
      'data-relationship': kind,
      'aria-label': `Open thread: ${row.title}`,
    },
    el('span', { class: 'pr-thread-title' }, row.title),
    // "Produced by" already says how a producer relates; only related chips need a kind.
    ...(kind === 'related' ? [el('span', { class: 'pr-thread-kind' }, kindLabel)] : []),
  )
  button.addEventListener('click', () => {
    openThread(row.threadId)
  })
  return button
}

/**
 * Shared list affordance; one click target for every producing or related thread.
 * A producer reads as a byline with the related threads behind a toggle on the
 * same row; with no producer the related threads are the byline.
 */
export function renderPrThreadRelationships(
  rows: readonly PrThreadRelationship[],
  openThread: (id: string) => void,
  view: PrThreadRelationshipsView = {},
): HTMLElement {
  const host = el('section', {
    class: 'pr-thread-relationships',
    'aria-label': 'PR thread relationships',
  })
  const produced = rows.filter((row) => row.kinds.includes('produced'))
  const related = rows.filter((row) => !row.kinds.includes('produced'))

  if (produced.length > 0) {
    host.append(
      el(
        'div',
        { class: 'pr-thread-group', 'data-relationship-group': 'produced' },
        el('h5', {}, 'Produced by'),
        ...produced.map((row) => threadChip(row, 'produced', openThread)),
      ),
    )
  }
  if (related.length === 0) return host

  if (produced.length === 0) {
    host.append(
      el(
        'div',
        { class: 'pr-thread-group', 'data-relationship-group': 'related' },
        el('h5', {}, 'Related threads'),
        ...related.map((row) => threadChip(row, 'related', openThread)),
      ),
    )
    return host
  }

  let expanded = view.expanded ?? false
  const group = el(
    'div',
    {
      class: 'pr-thread-group pr-thread-group-more',
      'data-relationship-group': 'related',
      'aria-label': 'Related threads',
    },
    ...related.map((row) => threadChip(row, 'related', openThread)),
  )
  const toggle = el(
    'button',
    { type: 'button', class: 'pr-thread-toggle' },
    el('span', {}, `${String(related.length)} related`),
    chevronRightIcon('ui-icon ui-icon-sm'),
  )
  const sync = (): void => {
    group.hidden = !expanded
    toggle.setAttribute('aria-expanded', String(expanded))
  }
  sync()
  toggle.addEventListener('click', () => {
    expanded = !expanded
    sync()
    view.onToggle?.(expanded)
  })
  host.append(toggle, group)
  return host
}
