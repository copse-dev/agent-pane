import type { ProcessManagerSnapshot, ProcessManagerRow } from '@shared/types/process-manager.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { clear, el } from '../dom/helpers.ts'
import { closeIcon, moreHorizontalIcon } from '../dom/icons.ts'
import { showContextMenu, type ContextMenuEntry } from '../dom/context-menu.ts'
import { switchProjectThread } from '../controller/projects.ts'
import { getThreadById } from '@shared/store/thread-helpers.ts'
import { showConfirmDialog } from './confirm-dialog.ts'
import { showErrorToast } from './toast.ts'
import { createOverlayDialog } from './dialog-shell.ts'

type SortColumn = 'cpu' | 'memory'

function sortedRows(
  rows: readonly ProcessManagerRow[],
  column: SortColumn,
  ascending: boolean,
): ProcessManagerRow[] {
  const direction = ascending ? 1 : -1
  return [...rows].sort((left, right) => {
    const a = column === 'cpu' ? left.cpuPercent : left.memoryMiB
    const b = column === 'cpu' ? right.cpuPercent : right.memoryMiB
    if (a === null) return b === null ? left.pid - right.pid : 1
    if (b === null) return -1
    return (a - b) * direction || left.pid - right.pid
  })
}

export function mountProcessManagerDialog(api: ApiClient, store: AppStore): () => void {
  const { dialog, open, close } = createOverlayDialog({
    id: 'process-manager-dialog',
    className: 'process-manager-overlay',
  })
  dialog.setAttribute('aria-labelledby', 'process-manager-title')

  const closeButton = el(
    'button',
    {
      type: 'button',
      class: 'ui-btn ui-btn-ghost process-manager-close',
      'aria-label': 'Close process manager',
    },
    closeIcon(),
  )
  closeButton.addEventListener('click', close)

  const cpuHeading = el('th', { scope: 'col', 'aria-sort': 'descending' })
  const memoryHeading = el('th', { scope: 'col', 'aria-sort': 'none' })
  const cpuButton = el('button', { type: 'button', class: 'process-manager-sort' }, 'CPU %')
  const memoryButton = el('button', { type: 'button', class: 'process-manager-sort' }, 'Memory')
  cpuHeading.append(cpuButton)
  memoryHeading.append(memoryButton)
  const body = el('tbody', { class: 'process-manager-rows' })
  const table = el(
    'table',
    { class: 'process-manager-table' },
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', { scope: 'col' }, 'Process'),
        el('th', { scope: 'col' }, 'Kind'),
        el('th', { scope: 'col' }, 'Thread'),
        cpuHeading,
        memoryHeading,
        el('th', { scope: 'col' }, 'PID'),
        el('th', { scope: 'col', 'aria-label': 'Actions' }),
      ),
    ),
    body,
  )
  const activityCount = el('span', { class: 'process-manager-activity-count' })
  const activityList = el('div', { class: 'process-manager-activity-list' })
  const activity = el(
    'section',
    { class: 'process-manager-activity', 'aria-label': 'Agent activity' },
    el(
      'div',
      { class: 'process-manager-activity-heading' },
      el('strong', {}, 'Agent activity'),
      activityCount,
    ),
    activityList,
  )
  activity.hidden = true
  const status = el('p', { class: 'process-manager-status', role: 'status' }, 'Loading processes…')
  const updated = el('span', { class: 'process-manager-updated', 'aria-hidden': 'true' })
  dialog.append(
    el(
      'div',
      { class: 'process-manager-shell' },
      el(
        'header',
        { class: 'process-manager-header' },
        el(
          'div',
          {},
          el('h2', { id: 'process-manager-title' }, 'Process Manager'),
          el('p', { class: 'process-manager-subtitle' }, 'Live Copse and thread processes'),
        ),
        closeButton,
      ),
      activity,
      el('div', { class: 'process-manager-scroll' }, table),
      el(
        'footer',
        { class: 'process-manager-footer' },
        el('span', {}, 'CPU is approximate; memory is physical RAM in MiB.'),
        updated,
      ),
      status,
    ),
  )

  let current: ProcessManagerSnapshot | null = null
  let column: SortColumn = 'cpu'
  let ascending = false
  let timer: ReturnType<typeof setInterval> | null = null
  let generation = 0
  let refreshing = false

  function projectFor(row: ProcessManagerRow): string | null {
    if (!row.threadId) return null
    const state = store.getState()
    return (
      row.projectId ??
      state.backgroundThreads.find((item) => item.thread.id === row.threadId)?.projectId ??
      (state.threads.some((thread) => thread.id === row.threadId) ? state.activeProjectId : null)
    )
  }

  async function stopManaged(row: ProcessManagerRow): Promise<void> {
    const handle = row.managed
    if (!handle) return
    const label = handle.kind === 'terminal' ? 'terminal' : 'background task'
    const confirmed = await showConfirmDialog({
      message: `Stop this ${label}?`,
      detail:
        handle.kind === 'terminal'
          ? 'This closes the terminal session and stops its shell.'
          : 'This stops the background task and its managed subprocesses.',
      confirmLabel: 'Stop',
      danger: true,
    })
    if (!confirmed) return
    try {
      if (handle.kind === 'terminal') {
        await api.terminal.destroy(handle.id)
      } else {
        const stopped = await api.processManager.stopBackground(
          handle.id,
          handle.projectId,
          handle.threadId,
        )
        if (!stopped) {
          showErrorToast('Could not stop that task', 'It is no longer running.')
          return
        }
      }
      status.textContent = `Stopped ${label}.`
      void refresh()
    } catch (error) {
      showErrorToast(`Could not stop the ${label}`, error)
    }
  }

  function menuEntries(row: ProcessManagerRow): ContextMenuEntry[] {
    const entries: ContextMenuEntry[] = []
    const projectId = projectFor(row)
    if (row.threadId && projectId && store.getState().projects.some((p) => p.id === projectId)) {
      const threadId = row.threadId
      entries.push({
        label: 'Jump to thread',
        onSelect: () => {
          close()
          switchProjectThread(store, api, projectId, threadId)
        },
      })
    }
    if (row.threadId && getThreadById(store, row.threadId)?.status === 'running') {
      const threadId = row.threadId
      entries.push({
        label: 'Stop agent run',
        onSelect: () => {
          void api.agent.abort(threadId).catch((error: unknown) => {
            showErrorToast('Could not stop the agent run', error)
          })
        },
      })
    }
    if (row.managed) {
      entries.push({
        label: row.managed.kind === 'terminal' ? 'Stop terminal' : 'Stop background task',
        onSelect: () => {
          void stopManaged(row)
        },
      })
    }
    return entries
  }

  function render(snapshot: ProcessManagerSnapshot): void {
    cpuHeading.setAttribute(
      'aria-sort',
      column === 'cpu' ? (ascending ? 'ascending' : 'descending') : 'none',
    )
    memoryHeading.setAttribute(
      'aria-sort',
      column === 'memory' ? (ascending ? 'ascending' : 'descending') : 'none',
    )
    clear(body)
    clear(activityList)
    activity.hidden = snapshot.activeRunThreadIds.length === 0
    activityCount.textContent = `${String(snapshot.activeRunThreadIds.length)} working`
    for (const threadId of snapshot.activeRunThreadIds) {
      const title = getThreadById(store, threadId)?.title.trim()
      const label = title && title.length > 0 ? title : `Thread ${threadId.slice(0, 8)}`
      activityList.append(
        el(
          'span',
          { class: 'process-manager-activity-item', 'data-thread-id': threadId },
          el('span', { class: 'process-manager-activity-dot', 'aria-hidden': 'true' }),
          el('span', { class: 'process-manager-activity-state' }, 'Working'),
          el('span', { class: 'process-manager-activity-thread', title: label }, label),
        ),
      )
    }
    const state = store.getState()
    for (const row of sortedRows(snapshot.processes, column, ascending)) {
      const thread = getThreadById(store, row.threadId)
      const title = thread?.title.trim()
      const threadLabel = row.threadId
        ? title && title.length > 0
          ? title
          : `Thread ${row.threadId.slice(0, 8)}`
        : 'Shared'
      const entries = menuEntries(row)
      const actionsCell = el('td', { class: 'process-manager-actions' })
      if (entries.length > 0) {
        const actionsButton = el(
          'button',
          {
            type: 'button',
            class: 'ui-btn ui-btn-ghost process-manager-actions-button',
            'aria-label': `Actions for ${row.label} (${String(row.pid)})`,
          },
          moreHorizontalIcon('ui-icon ui-icon-sm'),
        )
        actionsButton.addEventListener('click', () => {
          const rect = actionsButton.getBoundingClientRect()
          showContextMenu(rect.right, rect.bottom, menuEntries(row), dialog)
        })
        actionsCell.append(actionsButton)
      }
      const tableRow = el(
        'tr',
        {
          'data-pid': String(row.pid),
          'data-kind': row.type,
          'data-thread-id': row.threadId ?? '',
          'data-active-thread': String(
            row.threadId !== null && row.threadId === state.activeThreadId,
          ),
        },
        el('td', { class: 'process-manager-name', title: row.label }, row.label),
        el('td', { class: 'process-manager-type' }, row.type),
        el('td', { class: 'process-manager-thread', title: threadLabel }, threadLabel),
        el(
          'td',
          { class: 'process-manager-number' },
          row.cpuPercent === null ? '—' : `${row.cpuPercent.toFixed(1)}%`,
        ),
        el(
          'td',
          { class: 'process-manager-number' },
          row.memoryMiB === null ? '—' : `${row.memoryMiB.toFixed(1)} MiB`,
        ),
        el('td', { class: 'process-manager-number process-manager-pid' }, String(row.pid)),
        actionsCell,
      )
      if (entries.length > 0) {
        tableRow.addEventListener('contextmenu', (event) => {
          event.preventDefault()
          showContextMenu(event.clientX, event.clientY, menuEntries(row), dialog)
        })
      }
      body.append(tableRow)
    }
    updated.textContent = `Updated ${new Date(snapshot.sampledAt).toLocaleTimeString()}`
    dialog.dataset['sampledAt'] = String(snapshot.sampledAt)
    status.textContent = snapshot.processes.length === 0 ? 'No processes found.' : ''
  }

  function isRequestCurrent(requestGeneration: number): boolean {
    return dialog.open && requestGeneration === generation
  }

  async function refresh(): Promise<void> {
    if (!dialog.open || refreshing || document.visibilityState === 'hidden') return
    refreshing = true
    const requestGeneration = generation
    try {
      const snapshot = await api.processManager.snapshot()
      if (isRequestCurrent(requestGeneration)) {
        current = snapshot
        render(snapshot)
      }
    } catch {
      if (isRequestCurrent(requestGeneration))
        status.textContent = 'Process metrics are unavailable.'
    } finally {
      refreshing = false
    }
  }

  function setSort(next: SortColumn): void {
    ascending = column === next ? !ascending : false
    column = next
    if (current) render(current)
  }
  cpuButton.addEventListener('click', () => {
    setSort('cpu')
  })
  memoryButton.addEventListener('click', () => {
    setSort('memory')
  })

  function onVisibilityChange(): void {
    if (document.visibilityState === 'visible') void refresh()
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  dialog.addEventListener('close', () => {
    generation++
    if (timer !== null) clearInterval(timer)
    timer = null
    refreshing = false
  })

  return () => {
    if (dialog.open) return
    current = null
    clear(body)
    status.textContent = 'Loading processes…'
    updated.textContent = ''
    open()
    void refresh()
    timer = setInterval(() => void refresh(), 1_000)
  }
}
