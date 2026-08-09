import { el, clear } from '../dom/helpers.ts'
import { showConfirmDialog } from './confirm-dialog.ts'
import { paneMaximizeButton } from './pane-maximize-button.ts'
import { panePopoutButton } from './pane-popout-button.ts'
import { openBrowserUrl } from '../controller/panels.ts'
import { showErrorToast, showToast } from './toast.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'

// Derive the row shape from the IPC surface so this view never imports
// main-process modules directly (same rule the Memories pane follows).
type PortScanResult = Awaited<ReturnType<ApiClient['ports']['list']>>
type PortRow = PortScanResult['rows'][number]

/**
 * How often the list re-scans while it is the visible pane. Each poll spawns a
 * scan tool plus a `ps`, so this only runs while the pane is actually on screen
 * — a dev server started a moment ago should appear without the user reaching
 * for Refresh, but nothing scans in the background.
 */
const POLL_MS = 5_000

function portsModeActive(store: AppStore): boolean {
  const { filesPaneOpen, rightPanelMode } = store.getState()
  return filesPaneOpen && rightPanelMode === 'ports'
}

/** Stable identity for a row across refreshes, so selection survives a re-scan. */
function rowKey(row: PortRow): string {
  return `${String(row.port)}:${String(row.pid ?? '')}`
}

/** What to call a listener: its command, or the port when the tool didn't name one. */
export function portRowLabel(row: PortRow): string {
  return row.command.trim() || `Port ${String(row.port)}`
}

/** Who owns a row, in one line. Null owners are the user's own apps and services. */
export function portOwnerLabel(row: PortRow): string {
  if (!row.owner) return 'Not started by Copse'
  return row.owner.kind === 'terminal' ? `Shell — ${row.owner.label}` : `Task — ${row.owner.label}`
}

/**
 * The Ports panel (#771's local half). Lists TCP ports in LISTEN state on this
 * machine, attributes the ones that descend from a Shells tab or a background
 * task, and offers open/kill for those. Everything else is shown but inert:
 * discovery is a scan of the host, so the list includes processes Copse has no
 * business killing.
 */
export function mountPortsPane(
  listRoot: HTMLElement,
  viewerRoot: HTMLElement,
  store: AppStore,
  api: ApiClient,
): () => void {
  let rows: PortRow[] = []
  // Null means no scan tool ran, which is not the same as "nothing is listening".
  let scanTool: string | null = null
  let selectedKey: string | null = null
  let loadToken = 0
  let pollTimer: ReturnType<typeof setInterval> | null = null

  // --- list column ----------------------------------------------------------
  const listHeader = el('div', { class: 'git-changes-header' })
  const refreshBtn = el(
    'button',
    {
      type: 'button',
      class: 'git-changes-refresh-btn ports-refresh-btn',
      'aria-label': 'Refresh ports',
      title: 'Refresh',
    },
    '↻',
  )
  listHeader.append(
    el('span', { class: 'git-changes-title' }, 'Ports'),
    panePopoutButton(store, api, 'ports', 'ports'),
    paneMaximizeButton(store, 'ports'),
    refreshBtn,
  )
  const listBody = el('div', { class: 'git-changes-list ports-list' })
  listRoot.append(listHeader, listBody)

  // --- detail column --------------------------------------------------------
  const emptyState = el(
    'div',
    { class: 'panel-empty ports-empty' },
    'Select a port to see what is holding it.',
  )
  const detail = el('div', { class: 'ports-detail', hidden: true })
  viewerRoot.append(emptyState, detail)

  function selectedRow(): PortRow | null {
    return rows.find((row) => rowKey(row) === selectedKey) ?? null
  }

  function renderDetail(): void {
    const row = selectedRow()
    if (!row) {
      detail.hidden = true
      emptyState.hidden = false
      return
    }
    emptyState.hidden = true
    detail.hidden = false
    clear(detail)

    const facts = el('dl', { class: 'ports-facts' })
    const addFact = (term: string, value: string): void => {
      facts.append(
        el('dt', { class: 'ports-fact-term' }, term),
        el('dd', { class: 'ports-fact-value' }, value),
      )
    }
    addFact('Port', String(row.port))
    addFact('Address', row.address || 'unknown')
    addFact('Process', row.command.trim() || 'unknown')
    addFact('PID', row.pid === null ? 'unknown' : String(row.pid))
    addFact('Owner', portOwnerLabel(row))

    const actions = el('div', { class: 'ports-actions' })
    if (row.url) {
      const url = row.url
      const openBtn = el(
        'button',
        { type: 'button', class: 'ports-btn ports-btn-primary ports-open-btn' },
        'Open in browser',
      )
      openBtn.addEventListener('click', () => {
        openBrowserUrl(store, url)
      })
      const copyBtn = el(
        'button',
        { type: 'button', class: 'ports-btn ports-copy-btn' },
        'Copy URL',
      )
      copyBtn.addEventListener('click', () => {
        void navigator.clipboard.writeText(url).then(
          () => {
            showToast(`Copied ${url}`)
          },
          (err: unknown) => {
            showErrorToast('Could not copy the URL', err)
          },
        )
      })
      actions.append(openBtn, copyBtn)
    }
    if (row.owner) {
      const killBtn = el(
        'button',
        { type: 'button', class: 'ports-btn ports-btn-danger ports-kill-btn' },
        'Kill',
      )
      killBtn.addEventListener('click', () => void kill(row, killBtn))
      actions.append(killBtn)
    }

    detail.append(el('h2', { class: 'ports-detail-title' }, `:${String(row.port)}`), facts)
    if (actions.childElementCount > 0) detail.append(actions)
    if (!row.owner) {
      detail.append(
        el(
          'p',
          { class: 'ports-detail-note' },
          'Copse only stops processes it started. Use your terminal for this one.',
        ),
      )
    }
  }

  function renderList(): void {
    clear(listBody)
    if (rows.length === 0) {
      // An empty list from a scanner that ran and an empty list because no
      // scanner exists look identical; saying "nothing is listening" for the
      // second is a confident wrong answer.
      listBody.append(
        el(
          'div',
          { class: 'git-changes-empty ports-list-empty' },
          scanTool === null
            ? 'No port scanner on this machine. Install lsof or ss to list ports.'
            : 'Nothing is listening. Ports appear here when a dev server starts.',
        ),
      )
      return
    }
    for (const row of rows) {
      const key = rowKey(row)
      const button = el('button', {
        type: 'button',
        class: `git-change-row ports-row${key === selectedKey ? ' is-selected' : ''}`,
        'data-port': String(row.port),
      })
      const main = el('div', { class: 'ports-row-main' })
      main.append(
        el('span', { class: 'ports-row-port' }, `:${String(row.port)}`),
        el('span', { class: 'ports-row-command' }, portRowLabel(row)),
      )
      button.append(main)
      if (row.owner) {
        button.append(
          el(
            'span',
            { class: 'ports-row-owner', title: portOwnerLabel(row) },
            row.owner.kind === 'terminal' ? 'Shell' : 'Task',
          ),
        )
      }
      button.addEventListener('click', () => {
        selectedKey = key
        renderList()
        renderDetail()
      })
      listBody.append(button)
    }
  }

  async function refresh(): Promise<void> {
    const token = ++loadToken
    let next: PortScanResult
    try {
      next = await api.ports.list()
    } catch {
      next = { rows: [], tool: null }
    }
    if (token !== loadToken) return
    rows = next.rows
    scanTool = next.tool
    // Drop a selection whose listener has gone (killed, or the server stopped).
    if (selectedKey && !rows.some((row) => rowKey(row) === selectedKey)) selectedKey = null
    renderList()
    renderDetail()
  }

  async function kill(row: PortRow, button: HTMLButtonElement): Promise<void> {
    const confirmed = await showConfirmDialog({
      message: `Stop ${portRowLabel(row)} on port ${String(row.port)}?`,
      confirmLabel: 'Kill',
      danger: true,
    })
    if (!confirmed) return
    button.disabled = true
    try {
      const result = await api.ports.kill(row.port)
      if (!result.killed) showErrorToast('Could not stop that process', result.reason ?? '')
    } catch (err) {
      showErrorToast('Could not stop that process', err)
    } finally {
      button.disabled = false
    }
    // The signal is asynchronous — re-scan so the row disappears once it dies
    // rather than pretending it already has.
    await refresh()
  }

  function stopPolling(): void {
    if (pollTimer === null) return
    clearInterval(pollTimer)
    pollTimer = null
  }

  function syncPolling(): void {
    if (!portsModeActive(store)) {
      stopPolling()
      return
    }
    void refresh()
    if (pollTimer !== null) return
    pollTimer = setInterval(() => void refresh(), POLL_MS)
  }

  refreshBtn.addEventListener('click', () => void refresh())

  const unsubs = [
    store.on('right_panel_mode_changed', syncPolling),
    store.on('files_pane_changed', syncPolling),
  ]

  renderList()
  renderDetail()
  // Mounting into an already-active pane (pop-out window, restored layout) misses
  // the *_changed events that normally start the first scan.
  syncPolling()

  return () => {
    unsubs.forEach((u) => {
      u()
    })
    stopPolling()
    loadToken++
  }
}
