import type { NetworkActivitySnapshot, NetworkActivityRow } from '@shared/types/network-activity.ts'
import { clear, el } from '../dom/helpers.ts'

function bytes(value: number | null): string {
  if (value === null) return '—'
  if (value < 1024) return `${String(value)} B`
  return `${(value / 1024 ** (value < 1024 * 1024 ? 1 : 2)).toFixed(1)} ${value < 1024 * 1024 ? 'KiB' : 'MiB'}`
}

const statuses: Record<NetworkActivityRow['status'], string> = {
  running: 'Running',
  connecting: 'Connecting',
  active: 'Connected',
  completed: 'Completed',
  closed: 'Closed',
  failed: 'Failed',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
  'timed-out': 'Timed out',
}

export function createNetworkActivityView(threadLabel: (threadId: string | null) => string): {
  element: HTMLElement
  render: (snapshot: NetworkActivitySnapshot | undefined, sampledAt: number) => void
} {
  const search = el('input', {
    type: 'search',
    class: 'network-activity-search',
    placeholder: 'Filter activity or destination…',
    'aria-label': 'Filter network activity',
  })
  const activeOnly = el('input', { type: 'checkbox' })
  const body = el('tbody')
  const summary = el('p', { class: 'network-activity-summary', role: 'status' })
  const empty = el('p', { class: 'network-activity-empty' })
  const table = el(
    'table',
    { class: 'network-activity-table' },
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        ...['Activity', 'Destination', 'Thread', 'Status', 'Elapsed', 'Sent', 'Received'].map(
          (label) => el('th', { scope: 'col' }, label),
        ),
      ),
    ),
    body,
  )
  const element = el(
    'section',
    { class: 'network-activity-panel', 'aria-label': 'Network activity' },
    el(
      'div',
      { class: 'network-activity-toolbar' },
      search,
      el('label', {}, activeOnly, ' Active only'),
    ),
    el('div', { class: 'process-manager-scroll' }, table, empty),
    summary,
    el(
      'p',
      { class: 'network-activity-coverage' },
      'Command activity, container connections, and sandbox blocks. HTTPS request paths and status codes are not captured.',
    ),
  )
  let current: NetworkActivitySnapshot | undefined
  let now = 0
  function render(snapshot: NetworkActivitySnapshot | undefined, sampledAt: number): void {
    current = snapshot
    now = sampledAt
    const query = search.value.trim().toLowerCase()
    const rows = (snapshot?.rows ?? []).filter(
      (row) =>
        (!activeOnly.checked || row.endedAt === null) &&
        `${row.label} ${row.target ?? ''} ${threadLabel(row.threadId)} ${statuses[row.status]}`
          .toLowerCase()
          .includes(query),
    )
    clear(body)
    for (const row of rows) {
      const state =
        row.exitCode === null
          ? statuses[row.status]
          : `${statuses[row.status]} (${String(row.exitCode)})`
      const elapsed = Math.max(0, (row.endedAt ?? sampledAt) - row.startedAt)
      const label = threadLabel(row.threadId)
      body.append(
        el(
          'tr',
          { 'data-activity-id': String(row.id), 'data-status': row.status },
          el(
            'td',
            {},
            el('span', { class: 'network-activity-label', title: row.label }, row.label),
            el(
              'small',
              {},
              row.source === 'command'
                ? 'Command'
                : row.source === 'container'
                  ? 'Container'
                  : 'Sandbox',
            ),
          ),
          el(
            'td',
            { title: row.target ?? 'Destination not captured for commands' },
            row.target ?? '—',
          ),
          el('td', { title: label }, label),
          el('td', {}, el('span', { class: 'network-activity-state' }, state)),
          el('td', {}, `${(elapsed / 1000).toFixed(1)} s`),
          el('td', {}, bytes(row.bytesSent)),
          el('td', {}, bytes(row.bytesReceived)),
        ),
      )
    }
    table.hidden = rows.length === 0
    empty.hidden = rows.length > 0
    empty.textContent =
      snapshot === undefined
        ? 'Network activity is unavailable in this runtime.'
        : snapshot.rows.length === 0
          ? 'No network activity yet. Captured commands and connections will appear here.'
          : 'No activity matches these filters.'
    const active = snapshot?.rows.filter((row) => row.endedAt === null).length ?? 0
    summary.textContent = `${String(active)} active · ${String(rows.length)} shown · Recent session activity${snapshot?.dropped ? ` · ${String(snapshot.dropped)} older entries discarded` : ''}`
  }
  search.addEventListener('input', () => {
    render(current, now)
  })
  activeOnly.addEventListener('change', () => {
    render(current, now)
  })
  return { element, render }
}
