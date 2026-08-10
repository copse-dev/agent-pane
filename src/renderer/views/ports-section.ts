import { el, clear } from '../dom/helpers.ts'
import { showConfirmDialog } from './confirm-dialog.ts'
import { openBrowserUrl } from '../controller/panels.ts'
import { showErrorToast, showToast } from './toast.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'

// Derive the row shape from the IPC surface so this view never imports
// main-process modules directly (same rule the Memories pane follows).
type PortScanResult = Awaited<ReturnType<ApiClient['ports']['list']>>
type PortRow = PortScanResult['rows'][number]

/**
 * How often the list re-scans while the Terminal pane is on screen. Each poll
 * spawns a scan tool plus a `ps`, so nothing runs while the section is not
 * visible — but a dev server started a moment ago should appear without the
 * user reaching for anything.
 */
const POLL_MS = 5_000

function terminalModeActive(store: AppStore): boolean {
  const { filesPaneOpen, rightPanelMode } = store.getState()
  return filesPaneOpen && rightPanelMode === 'terminal'
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
 * The Ports section (#771's local half) — a section in the Terminal tab's left
 * rail, beneath the shells and agent tasks, because a listening port is a
 * property of something running in one of them.
 *
 * Discovery is a scan of the host, not a record of what Copse spawned, so the
 * list includes the user's other apps and system services. Only a listener that
 * descends from a Shells tab or a background task is actionable; the rest are
 * shown and inert.
 */
export function mountPortsSection(
  listRoot: HTMLElement,
  store: AppStore,
  api: ApiClient,
): () => void {
  let rows: PortRow[] = []
  // Null means no scan tool ran, which is not the same as "nothing is listening".
  let scanTool: string | null = null
  let selectedKey: string | null = null
  let loadToken = 0
  let refreshTail: Promise<void> = Promise.resolve()
  let pollRunning = false
  let pollTimer: ReturnType<typeof setTimeout> | null = null

  const section = el('section', { class: 'ports-section', hidden: true })
  const header = el('div', { class: 'agent-tasks-section-header' }, 'Ports')
  const list = el('div', { class: 'ports-list' })
  section.append(header, list)
  listRoot.append(section)

  function actionButton(label: string, className: string, onClick: () => void): HTMLButtonElement {
    const button = el('button', { type: 'button', class: `ports-btn ${className}` }, label)
    button.addEventListener('click', (event) => {
      // The row itself is a button; a click on an action must not re-toggle it.
      event.stopPropagation()
      onClick()
    })
    return button
  }

  /** The expanded body under a selected row: the facts that fit, then actions. */
  function renderDetail(row: PortRow): HTMLElement {
    const detail = el('div', { class: 'ports-detail' })
    const pid = row.pid === null ? 'pid unknown' : `pid ${String(row.pid)}`
    detail.append(
      el('div', { class: 'ports-detail-line' }, `${row.address || 'unknown'} · ${pid}`),
      el('div', { class: 'ports-detail-line' }, portOwnerLabel(row)),
    )

    const actions = el('div', { class: 'ports-actions' })
    if (row.url) {
      const url = row.url
      actions.append(
        actionButton('Open', 'ports-open-btn', () => {
          openBrowserUrl(store, url)
        }),
        actionButton('Copy', 'ports-copy-btn', () => {
          void navigator.clipboard.writeText(url).then(
            () => {
              showToast(`Copied ${url}`)
            },
            (err: unknown) => {
              showErrorToast('Could not copy the URL', err)
            },
          )
        }),
      )
    }
    if (row.owner) {
      const killBtn = actionButton('Kill', 'ports-btn-danger ports-kill-btn', () => {
        void kill(row, killBtn)
      })
      actions.append(killBtn)
    }
    if (actions.childElementCount > 0) detail.append(actions)
    else {
      detail.append(
        el('div', { class: 'ports-detail-note' }, 'Copse only stops processes it started.'),
      )
    }
    return detail
  }

  function render(): void {
    clear(list)
    // Siblings in this rail (shells, agent tasks, background tasks) hide when
    // they have nothing, and "no dev server running" is the common case. A host
    // with no scan tool is different: that is a standing, fixable condition the
    // user would otherwise never learn about, so it says so.
    if (rows.length === 0) {
      section.hidden = scanTool !== null
      if (scanTool === null) {
        list.append(
          el(
            'div',
            { class: 'ports-empty' },
            'No port scanner on this machine. Install lsof or ss to list ports.',
          ),
        )
      }
      return
    }
    section.hidden = false

    for (const row of rows) {
      const key = rowKey(row)
      const selected = key === selectedKey
      const item = el('div', { class: 'ports-item' })
      const button = el('button', {
        type: 'button',
        class: `ports-row${selected ? ' is-active' : ''}`,
        'data-port': String(row.port),
        'aria-expanded': String(selected),
      })
      button.append(
        el('span', { class: 'ports-row-port' }, `:${String(row.port)}`),
        el('span', { class: 'ports-row-command' }, portRowLabel(row)),
      )
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
        selectedKey = selected ? null : key
        render()
      })
      item.append(button)
      if (selected) item.append(renderDetail(row))
      list.append(item)
    }
  }

  async function runRefresh(): Promise<void> {
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
    render()
  }

  // A host scan can exceed POLL_MS (notably lsof on a busy macOS host). Queue
  // callers behind the current scan so future refresh sources cannot spawn
  // overlapping lsof/ps pairs or discard every completion.
  function refresh(): Promise<void> {
    const queued = refreshTail.then(runRefresh, runRefresh)
    refreshTail = queued.catch(() => {})
    return queued
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
      if (!result.killed) {
        showErrorToast('Could not stop that process', result.reason ?? '')
      } else {
        // A refresh that began before the signal can still hold a pre-kill
        // snapshot. Invalidate it before removing the row so it cannot put the
        // listener back after this accepted action renders.
        loadToken++
        const killedKey = rowKey(row)
        rows = rows.filter((candidate) => rowKey(candidate) !== killedKey)
        if (selectedKey === killedKey) selectedKey = null
        render()
      }
    } catch (err) {
      showErrorToast('Could not stop that process', err)
    }
    // The regular serialized poll reconciles the optimistic removal after the
    // SIGTERM/SIGKILL grace period without blocking this action on a slow lsof.
  }

  function stopPolling(): void {
    if (pollTimer === null) return
    clearTimeout(pollTimer)
    pollTimer = null
  }

  async function pollOnce(): Promise<void> {
    if (pollRunning || !terminalModeActive(store)) return
    pollRunning = true
    try {
      await refresh()
    } finally {
      pollRunning = false
      if (terminalModeActive(store) && pollTimer === null) {
        pollTimer = setTimeout(() => {
          pollTimer = null
          void pollOnce()
        }, POLL_MS)
      }
    }
  }

  function syncPolling(): void {
    if (!terminalModeActive(store)) {
      stopPolling()
      return
    }
    void pollOnce()
  }

  const unsubs = [
    store.on('right_panel_mode_changed', syncPolling),
    store.on('files_pane_changed', syncPolling),
  ]

  render()
  // Mounting into an already-active pane (pop-out window, restored layout) misses
  // the *_changed events that normally start the first scan.
  syncPolling()

  return () => {
    unsubs.forEach((u) => {
      u()
    })
    stopPolling()
    loadToken++
    section.remove()
  }
}
