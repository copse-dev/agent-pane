import type { ProcessManagerSnapshot, ProcessManagerRow } from '@shared/types/process-manager.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { clear, el } from '../dom/helpers.ts'
import { chevronRightIcon, closeIcon, moreHorizontalIcon } from '../dom/icons.ts'
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

interface ProcessGroup {
  threadId: string | null
  rows: ProcessManagerRow[]
  cpuPercent: number | null
  memoryMiB: number | null
}

function total(values: readonly (number | null)[]): number | null {
  const known = values.filter((value) => value !== null)
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0)
}

/** Thread-owned processes grouped per thread, ordered like their rows; shared processes last. */
function groupedRows(
  rows: readonly ProcessManagerRow[],
  column: SortColumn,
  ascending: boolean,
): ProcessGroup[] {
  const byThread = new Map<string | null, ProcessManagerRow[]>()
  for (const row of sortedRows(rows, column, ascending)) {
    const group = byThread.get(row.threadId)
    if (group) group.push(row)
    else byThread.set(row.threadId, [row])
  }
  const groups = [...byThread].map(([threadId, groupRows]) => ({
    threadId,
    rows: groupRows,
    cpuPercent: total(groupRows.map((row) => row.cpuPercent)),
    memoryMiB: total(groupRows.map((row) => row.memoryMiB)),
  }))
  const direction = ascending ? 1 : -1
  return groups.sort((left, right) => {
    if (left.threadId === null) return right.threadId === null ? 0 : 1
    if (right.threadId === null) return -1
    const a = column === 'cpu' ? left.cpuPercent : left.memoryMiB
    const b = column === 'cpu' ? right.cpuPercent : right.memoryMiB
    if (a === null) return b === null ? left.threadId.localeCompare(right.threadId) : 1
    if (b === null) return -1
    return (a - b) * direction || left.threadId.localeCompare(right.threadId)
  })
}

function formatCpu(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`
}

function formatMemory(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)} MiB`
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
          el('p', { class: 'process-manager-subtitle' }, 'Live Copse and managed task processes'),
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
  /** Thread groups the user collapsed (`''` is Shared); every group starts expanded. */
  const collapsedGroups = new Set<string>()

  function projectForThread(threadId: string, projectId?: string | null): string | null {
    const state = store.getState()
    return (
      projectId ??
      state.backgroundThreads.find((item) => item.thread.id === threadId)?.projectId ??
      (state.threads.some((thread) => thread.id === threadId) ? state.activeProjectId : null)
    )
  }

  function jumpToThread(projectId: string, threadId: string): void {
    close()
    switchProjectThread(store, api, projectId, threadId)
  }

  function stopAgentRun(threadId: string): void {
    void api.agent.abort(threadId).catch((error: unknown) => {
      showErrorToast('Could not stop the agent run', error)
    })
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

  function threadMenuEntries(
    threadId: string,
    projectId: string | null,
    running: boolean,
  ): ContextMenuEntry[] {
    const entries: ContextMenuEntry[] = []
    if (projectId && store.getState().projects.some((project) => project.id === projectId)) {
      entries.push({
        label: 'Jump to thread',
        onSelect: () => {
          jumpToThread(projectId, threadId)
        },
      })
    }
    if (running) {
      entries.push({
        label: 'Stop agent run',
        onSelect: () => {
          stopAgentRun(threadId)
        },
      })
    }
    return entries
  }

  function threadLabel(threadId: string | null): string {
    if (threadId === null) return 'Shared'
    const title = getThreadById(store, threadId)?.title.trim()
    return title && title.length > 0 ? title : `Thread ${threadId.slice(0, 8)}`
  }

  function threadEntries(threadId: string | null): ContextMenuEntry[] {
    return threadId
      ? threadMenuEntries(
          threadId,
          projectForThread(threadId),
          getThreadById(store, threadId)?.status === 'running',
        )
      : []
  }

  function actionsCellFor(label: string, entries: () => ContextMenuEntry[]): HTMLElement {
    const cell = el('td', { class: 'process-manager-actions' })
    if (entries().length === 0) return cell
    const button = el(
      'button',
      {
        type: 'button',
        class: 'ui-btn ui-btn-ghost process-manager-actions-button',
        'aria-label': `Actions for ${label}`,
      },
      moreHorizontalIcon('ui-icon ui-icon-sm'),
    )
    button.addEventListener('click', () => {
      const rect = button.getBoundingClientRect()
      showContextMenu(rect.right, rect.bottom, entries(), dialog)
    })
    cell.append(button)
    return cell
  }

  function menuEntries(row: ProcessManagerRow): ContextMenuEntry[] {
    const entries = row.threadId
      ? threadMenuEntries(
          row.threadId,
          projectForThread(row.threadId, row.projectId),
          getThreadById(store, row.threadId)?.status === 'running',
        )
      : []
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
    const focusedActivityThread =
      document.activeElement instanceof HTMLElement && activityList.contains(document.activeElement)
        ? document.activeElement.dataset['threadId']
        : undefined
    const focusedGroup =
      document.activeElement instanceof HTMLElement &&
      body.contains(document.activeElement) &&
      document.activeElement.classList.contains('process-manager-group-toggle')
        ? document.activeElement.dataset['groupKey']
        : undefined
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
      const projectId = projectForThread(threadId)
      const canNavigate = Boolean(
        projectId && store.getState().projects.some((project) => project.id === projectId),
      )
      const item = el(
        'button',
        {
          type: 'button',
          class: 'process-manager-activity-item',
          'data-thread-id': threadId,
          'aria-label': canNavigate ? `Working ${label}: open thread` : `Working ${label}`,
        },
        el('span', { class: 'process-manager-activity-dot', 'aria-hidden': 'true' }),
        el('span', { class: 'process-manager-activity-state' }, 'Working'),
        el('span', { class: 'process-manager-activity-thread', title: label }, label),
      )
      if (projectId && canNavigate) {
        item.addEventListener('click', () => {
          jumpToThread(projectId, threadId)
        })
      } else {
        item.setAttribute('aria-disabled', 'true')
      }
      item.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        showContextMenu(
          event.clientX,
          event.clientY,
          threadMenuEntries(threadId, projectId, true),
          dialog,
        )
      })
      item.addEventListener('keydown', (event) => {
        if (event.key !== 'F10' || !event.shiftKey) return
        event.preventDefault()
        const rect = item.getBoundingClientRect()
        showContextMenu(
          rect.left,
          rect.bottom,
          threadMenuEntries(threadId, projectId, true),
          dialog,
        )
      })
      activityList.append(item)
      if (threadId === focusedActivityThread) item.focus({ preventScroll: true })
    }
    if (focusedActivityThread && !snapshot.activeRunThreadIds.includes(focusedActivityThread)) {
      closeButton.focus({ preventScroll: true })
    }
    const state = store.getState()
    for (const group of groupedRows(snapshot.processes, column, ascending)) {
      const groupKey = group.threadId ?? ''
      const expanded = !collapsedGroups.has(groupKey)
      const label = threadLabel(group.threadId)
      const count = `${String(group.rows.length)} ${group.rows.length === 1 ? 'process' : 'processes'}`
      const toggle = el(
        'button',
        {
          type: 'button',
          class: 'process-manager-group-toggle',
          'data-group-key': groupKey,
          'aria-expanded': String(expanded),
        },
        chevronRightIcon('ui-icon ui-icon-sm process-manager-group-chevron'),
        el('span', { class: 'process-manager-group-title', title: label }, label),
        el('span', { class: 'process-manager-group-count' }, count),
      )
      toggle.addEventListener('click', () => {
        if (collapsedGroups.has(groupKey)) collapsedGroups.delete(groupKey)
        else collapsedGroups.add(groupKey)
        if (current) render(current)
      })
      const groupEntries = (): ContextMenuEntry[] => threadEntries(group.threadId)
      const header = el(
        'tr',
        {
          class: 'process-manager-group',
          'data-group-key': groupKey,
          'data-active-thread': String(
            group.threadId !== null && group.threadId === state.activeThreadId,
          ),
        },
        el('th', { scope: 'rowgroup', colspan: '3' }, toggle),
        el('td', { class: 'process-manager-number' }, formatCpu(group.cpuPercent)),
        el('td', { class: 'process-manager-number' }, formatMemory(group.memoryMiB)),
        el('td'),
        actionsCellFor(label, groupEntries),
      )
      if (groupEntries().length > 0) {
        header.addEventListener('contextmenu', (event) => {
          event.preventDefault()
          showContextMenu(event.clientX, event.clientY, groupEntries(), dialog)
        })
      }
      body.append(header)
      if (groupKey === focusedGroup) toggle.focus({ preventScroll: true })
      for (const row of group.rows) {
        const entries = menuEntries(row)
        const tableRow = el(
          'tr',
          {
            class: 'process-manager-process',
            'data-pid': String(row.pid),
            'data-kind': row.type,
            'data-thread-id': row.threadId ?? '',
            'data-active-thread': String(
              row.threadId !== null && row.threadId === state.activeThreadId,
            ),
          },
          el('td', { class: 'process-manager-name', title: row.label }, row.label),
          el('td', { class: 'process-manager-type' }, row.type),
          el('td', { class: 'process-manager-thread', title: label }, label),
          el('td', { class: 'process-manager-number' }, formatCpu(row.cpuPercent)),
          el('td', { class: 'process-manager-number' }, formatMemory(row.memoryMiB)),
          el('td', { class: 'process-manager-number process-manager-pid' }, String(row.pid)),
          actionsCellFor(`${row.label} (${String(row.pid)})`, () => menuEntries(row)),
        )
        tableRow.hidden = !expanded
        if (entries.length > 0) {
          tableRow.addEventListener('contextmenu', (event) => {
            event.preventDefault()
            showContextMenu(event.clientX, event.clientY, menuEntries(row), dialog)
          })
        }
        body.append(tableRow)
      }
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
