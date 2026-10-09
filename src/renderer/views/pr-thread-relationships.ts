import { el } from '../dom/helpers.ts'
import type { PrThreadRelationship } from '@shared/git/thread-pr-relations.ts'

/** Shared list affordance; one click target for every producing or related thread. */
export function renderPrThreadRelationships(
  rows: readonly PrThreadRelationship[],
  openThread: (id: string) => void,
): HTMLElement {
  const host = el('section', {
    class: 'pr-thread-relationships',
    'aria-label': 'PR thread relationships',
  })
  const groups = [
    {
      label: 'Producing threads',
      kind: 'produced',
      rows: rows.filter((row) => row.kinds.includes('produced')),
    },
    {
      label: 'Related threads',
      kind: 'related',
      rows: rows.filter((row) => !row.kinds.includes('produced')),
    },
  ]
  for (const group of groups) {
    if (group.rows.length === 0) continue
    const section = el(
      'div',
      { class: 'pr-thread-group', 'data-relationship-group': group.kind },
      el('h5', {}, group.label),
    )
    for (const row of group.rows) {
      const label = row.kinds.includes('produced')
        ? 'Created PR'
        : row.kinds.includes('agent-linked')
          ? 'Agent-linked'
          : 'Referenced PR'
      const button = el(
        'button',
        {
          type: 'button',
          class: 'pr-open-thread-btn pr-thread-link',
          'data-thread-id': row.threadId,
          'data-relationship': group.kind,
          'aria-label': `Open thread: ${row.title}`,
        },
        el('span', { class: 'pr-thread-title' }, row.title),
        el('span', { class: 'pr-thread-kind' }, label),
      )
      button.addEventListener('click', () => {
        openThread(row.threadId)
      })
      section.append(button)
    }
    host.append(section)
  }
  return host
}
