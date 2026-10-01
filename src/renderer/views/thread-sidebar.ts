import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { openNewThread } from '@shared/store/thread-helpers.ts'
import { el } from '../dom/helpers.ts'
import {
  arrowDownIcon,
  checkIcon,
  chevronDownIcon,
  fileTextIcon,
  handIcon,
  messageQuestionIcon,
  plusIcon,
  runningStatusIcon,
  searchIcon,
  warningIcon,
} from '../dom/icons.ts'
import { formatAge, trackRunTimings } from '../controller/activity-model.ts'
import {
  createThreadBrowserData,
  threadEntryKey,
  type ThreadBrowserEntry,
} from '../controller/thread-browser.ts'
import { filterText } from '../controller/thread-filter.ts'
import {
  isProjectSwitchInFlight,
  projectDisplayName,
  switchProjectThread,
} from '../controller/projects.ts'
import { mountProjectsPane } from './projects-pane.ts'
import type { ActivitySources } from './activity-panel.ts'
import { openSettingsDialog } from './settings-dialog.ts'

type ThreadGroup = 'needs-you' | 'working' | 'changes' | 'threads'
type SortColumn = 'activity' | 'updated' | 'title' | 'work'

export function mountThreadSidebar(
  root: HTMLElement,
  store: AppStore,
  api: ApiClient,
  sources: ActivitySources,
): () => void {
  const pane = el('div', { class: 'thread-browser' })
  const projectsPane = el('div', { class: 'thread-project-manager', hidden: true })
  const back = el('button', { class: 'thread-browser-back', type: 'button' }, '← Threads')
  const projectHost = el('div', { class: 'thread-project-host' })
  projectsPane.append(back, projectHost)
  root.append(pane, projectsPane)
  let disposeProjects: (() => void) | undefined
  let disposed = false
  let frame: number | undefined
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let selectedProject = ''
  let query = ''
  let onlyWork = false
  let onlyAttention = false
  let onlyWorking = false
  let sort: SortColumn = 'activity'
  let ascending = false
  let limit = 40
  const collapsed = new Set<string>()
  const timings = trackRunTimings(store, Date.now)
  const data = createThreadBrowserData(store, api, scheduleRender)

  function showProjects(): void {
    pane.hidden = true
    projectsPane.hidden = false
    disposeProjects ??= mountProjectsPane(projectHost, store, api)
  }

  back.addEventListener('click', () => {
    disposeProjects?.()
    disposeProjects = undefined
    projectHost.replaceChildren()
    projectsPane.hidden = true
    pane.hidden = false
    data.refresh()
    render()
  })
  const manage = el('button', { type: 'button', class: 'thread-browser-manage' }, 'Projects')
  manage.addEventListener('click', showProjects)
  const newThread = el(
    'button',
    { type: 'button', 'aria-label': 'New thread', class: 'projects-add-btn' },
    plusIcon('ui-icon ui-icon-sm'),
  )
  newThread.addEventListener('click', () => {
    const state = store.getState()
    const targetProjectId = state.expandedProjectId ?? state.activeProjectId
    if (targetProjectId && isProjectSwitchInFlight(store, targetProjectId)) return
    if (!store.getState().activeProjectId) showProjects()
    else {
      query = ''
      search.value = ''
      selectedProject = ''
      onlyWork = false
      onlyAttention = false
      onlyWorking = false
      workToggle.setAttribute('aria-pressed', 'false')
      attentionToggle.setAttribute('aria-pressed', 'false')
      openNewThread(store)
    }
  })
  const totalCount = el('span', { class: 'thread-browser-total' })
  const header = el(
    'div',
    { class: 'thread-browser-heading' },
    el('h2', {}, 'Threads'),
    totalCount,
    newThread,
  )
  const search = el('input', {
    type: 'search',
    class: 'thread-browser-search-input',
    'aria-label': 'Find threads',
    placeholder: 'Search threads…',
  })
  search.addEventListener('input', () => {
    query = filterText(search.value.trim())
    limit = 40
    render()
  })
  const sortSelect = el(
    'select',
    { 'aria-label': 'Sort threads' },
    el('option', { value: 'activity' }, 'Activity order'),
    el('option', { value: 'updated' }, 'Updated'),
    el('option', { value: 'title' }, 'Thread name'),
    el('option', { value: 'work' }, 'Changed files'),
  )
  sortSelect.addEventListener('change', () => {
    const value = sortSelect.value
    if (value !== 'activity' && value !== 'updated' && value !== 'title' && value !== 'work') return
    sort = value
    ascending = value === 'title'
    render()
  })
  const projectSelect = el('select', { 'aria-label': 'Filter by project' })
  projectSelect.addEventListener('change', () => {
    selectedProject = projectSelect.value
    limit = 40
    render()
  })
  const workToggle = el(
    'button',
    {
      type: 'button',
      class: 'thread-work-filter',
      'aria-pressed': 'false',
      'aria-label': 'Show only threads with uncommitted changes',
    },
    'Only changes',
  )
  workToggle.addEventListener('click', () => {
    onlyWork = !onlyWork
    workToggle.setAttribute('aria-pressed', String(onlyWork))
    limit = 40
    render()
  })
  const attentionToggle = el(
    'button',
    { type: 'button', class: 'thread-attention-filter', 'aria-pressed': 'false' },
    'Needs you',
  )
  attentionToggle.addEventListener('click', () => {
    onlyAttention = !onlyAttention
    onlyWorking = false
    attentionToggle.setAttribute('aria-pressed', String(onlyAttention))
    render()
  })
  const workingToggle = el('button', {
    type: 'button',
    class: 'thread-working-filter',
    'aria-pressed': 'false',
  })
  workingToggle.addEventListener('click', () => {
    onlyWorking = !onlyWorking
    onlyAttention = false
    render()
  })
  const sortDirection = el('button', { type: 'button', class: 'thread-browser-sort-direction' })
  sortDirection.append(arrowDownIcon('ui-icon ui-icon-sm'))
  sortDirection.addEventListener('click', () => {
    ascending = !ascending
    render()
  })
  const list = el('div', { class: 'thread-browser-list', 'aria-label': 'Threads' })
  const status = el('span', { role: 'status', class: 'thread-browser-status' })
  const refresh = el(
    'button',
    { type: 'button', 'aria-label': 'Refresh threads and Git status' },
    'Refresh',
  )
  refresh.addEventListener('click', () => {
    data.refresh()
    render()
  })
  const settings = el(
    'button',
    { type: 'button', class: 'projects-settings-btn', 'aria-label': 'Settings' },
    'Settings',
  )
  settings.addEventListener('click', () => {
    openSettingsDialog()
  })
  pane.append(
    header,
    el('div', { class: 'thread-browser-summary' }, attentionToggle, workingToggle),
    el('div', { class: 'thread-browser-search' }, searchIcon('ui-icon ui-icon-sm'), search),
    el(
      'div',
      { class: 'thread-browser-controls' },
      projectSelect,
      el('div', { class: 'thread-browser-sort' }, sortDirection, sortSelect),
    ),
    list,
    el('div', { class: 'thread-browser-footer' }, status, refresh),
    el('div', { class: 'projects-settings-actions' }, manage, settings),
  )

  function scheduleRender(): void {
    if (disposed || frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      if (!disposed) render()
    })
  }

  function render(): void {
    if (disposed) return
    data.load()
    const state = store.getState()
    const targetProjectId = state.expandedProjectId ?? state.activeProjectId
    newThread.disabled = Boolean(targetProjectId && isProjectSwitchInFlight(store, targetProjectId))
    const projectOptions = [
      el('option', { value: '' }, 'All projects'),
      ...state.projects.map((project) =>
        el('option', { value: project.id }, projectDisplayName(project)),
      ),
    ]
    if (!state.projects.some((project) => project.id === selectedProject)) selectedProject = ''
    projectSelect.replaceChildren(...projectOptions)
    projectSelect.value = selectedProject
    const waiting = new Map<string, number>()
    for (const request of [...sources.approvals.pending(), ...sources.questions.pending()]) {
      if (request.threadId)
        waiting.set(
          request.threadId,
          Math.min(waiting.get(request.threadId) ?? Infinity, request.receivedAt),
        )
    }
    const groupFor = (entry: ThreadBrowserEntry): ThreadGroup =>
      waiting.has(entry.thread.id)
        ? 'needs-you'
        : entry.thread.status === 'running'
          ? 'working'
          : (data.summary(entry)?.count ?? 0) > 0
            ? 'changes'
            : 'threads'
    const all = data.entries()
    const scoped = all.filter(
      (entry) =>
        (!selectedProject || entry.project.id === selectedProject) &&
        (!query ||
          filterText(
            `${entry.thread.title} ${projectDisplayName(entry.project)} ${entry.thread.gitBranch ?? ''}`,
          ).includes(query)) &&
        (!onlyAttention || waiting.has(entry.thread.id)) &&
        (!onlyWorking || (entry.thread.status === 'running' && !waiting.has(entry.thread.id))),
    )
    data.inspect(scoped)
    const matching = scoped.filter((entry) => !onlyWork || (data.summary(entry)?.count ?? 0) > 0)
    const groupOrder: Record<ThreadGroup, number> = {
      'needs-you': 0,
      working: 1,
      changes: 2,
      threads: 3,
    }
    matching.sort((left, right) => {
      const groupComparison = groupOrder[groupFor(left)] - groupOrder[groupFor(right)]
      if (groupComparison !== 0) return groupComparison
      let comparison: number
      if (sort === 'title') comparison = left.thread.title.localeCompare(right.thread.title)
      else if (sort === 'work') {
        const leftWork = data.summary(left)
        const rightWork = data.summary(right)
        if (!leftWork || !rightWork)
          return leftWork
            ? -1
            : rightWork
              ? 1
              : threadEntryKey(left).localeCompare(threadEntryKey(right))
        comparison = leftWork.count - rightWork.count
      } else if (
        sort === 'activity' &&
        waiting.has(left.thread.id) &&
        waiting.has(right.thread.id)
      ) {
        comparison = (waiting.get(right.thread.id) ?? 0) - (waiting.get(left.thread.id) ?? 0)
      } else if (
        sort === 'activity' &&
        left.thread.status === 'running' &&
        right.thread.status === 'running'
      ) {
        comparison =
          (timings.runs.get(right.thread.id)?.startedAt ?? 0) -
          (timings.runs.get(left.thread.id)?.startedAt ?? 0)
      } else comparison = (left.thread.updatedAt ?? 0) - (right.thread.updatedAt ?? 0)
      return (
        (ascending ? comparison : -comparison) ||
        threadEntryKey(left).localeCompare(threadEntryKey(right))
      )
    })
    const selectedIndex = matching.findIndex(
      (entry) =>
        entry.project.id === state.activeProjectId && entry.thread.id === state.activeThreadId,
    )
    if (selectedIndex >= limit) limit = Math.ceil((selectedIndex + 1) / 40) * 40
    sortDirection.dataset['direction'] = ascending ? 'ascending' : 'descending'
    sortDirection.setAttribute(
      'aria-label',
      `Reverse sort order, currently ${ascending ? 'ascending' : 'descending'}`,
    )
    totalCount.textContent = String(all.length)
    attentionToggle.textContent = `${String(all.filter((entry) => waiting.has(entry.thread.id)).length)} need you`
    attentionToggle.setAttribute('aria-pressed', String(onlyAttention))
    workingToggle.textContent = `${String(all.filter((entry) => groupFor(entry) === 'working').length)} working`
    workingToggle.setAttribute('aria-pressed', String(onlyWorking))
    workToggle.textContent = onlyWork ? 'Clear filter' : 'Only changes'
    workToggle.setAttribute('aria-pressed', String(onlyWork))
    workToggle.setAttribute(
      'aria-label',
      onlyWork ? 'Clear uncommitted changes filter' : 'Show only threads with uncommitted changes',
    )
    const unknown = scoped.filter((entry) => data.summary(entry) == null).length
    workToggle.title =
      'Includes staged, unstaged and untracked work. Threads sharing a checkout share its changes.'
    status.textContent = `${String(matching.length)} ${matching.length === 1 ? 'thread' : 'threads'}${data.pending() ? ' · Checking…' : data.failed() ? ' · Some projects unavailable' : unknown > 0 && onlyWork ? ` · ${String(unknown)} unavailable` : ''}`
    const focusKey =
      document.activeElement?.closest<HTMLElement>('[data-entry-key]')?.dataset['entryKey']
    const groups = new Map<
      ThreadGroup,
      { label: string; context: string; rows: ThreadBrowserEntry[] }
    >([
      [
        'needs-you',
        { label: 'Needs you', context: sort === 'activity' ? 'longest wait first' : '', rows: [] },
      ],
      ['working', { label: 'Working', context: 'runtime', rows: [] }],
      ['changes', { label: 'Has changes', context: '', rows: [] }],
      ['threads', { label: 'Recent', context: 'updated', rows: [] }],
    ])
    for (const entry of matching) {
      groups.get(groupFor(entry))?.rows.push(entry)
    }
    const nodes: HTMLElement[] = []
    let remaining = limit
    for (const [key, group] of groups) {
      if (group.rows.length === 0 && key !== 'changes') continue
      const collapseKey = key
      const section = el('section', { class: 'thread-browser-group', 'data-group': key })
      const heading = el(
        'button',
        {
          type: 'button',
          class: 'thread-browser-group-heading',
          'aria-expanded': String(!collapsed.has(collapseKey)),
        },
        chevronDownIcon('ui-icon thread-browser-chevron'),
        el('span', { class: 'thread-browser-group-label' }, group.label),
        el('span', { class: 'thread-browser-group-count' }, String(group.rows.length)),
        el('span', { class: 'thread-browser-group-context' }, group.context),
      )
      heading.addEventListener('click', () => {
        if (collapsed.has(collapseKey)) collapsed.delete(collapseKey)
        else collapsed.add(collapseKey)
        render()
      })
      const headingRow = el('div', { class: 'thread-browser-group-header' }, heading)
      if (key === 'changes') headingRow.append(workToggle)
      section.append(headingRow)
      if (!collapsed.has(collapseKey)) {
        for (const entry of group.rows.slice(0, remaining))
          section.append(renderRow(entry, waiting.get(entry.thread.id)))
        remaining = Math.max(0, remaining - group.rows.length)
        if (key === 'changes' && group.rows.length === 0 && !onlyWork) {
          section.append(
            el(
              'p',
              { class: 'thread-browser-section-empty' },
              data.pending()
                ? 'Checking worktrees…'
                : scoped.some((entry) => (data.summary(entry)?.count ?? 0) > 0)
                  ? 'Active threads with changes are shown above.'
                  : 'No confirmed changes',
            ),
          )
        }
      }
      nodes.push(section)
    }
    if (matching.length === 0) {
      nodes.push(
        el(
          'div',
          { class: 'sidebar-empty' },
          data.pending()
            ? 'Checking threads…'
            : onlyWork && unknown > 0
              ? 'No confirmed uncommitted work. Some checkouts could not be checked.'
              : 'No matching threads',
        ),
      )
      const reset = el(
        'button',
        { type: 'button', class: 'thread-browser-reset' },
        state.projects.length === 0 ? 'Add a project' : 'Clear filters',
      )
      reset.addEventListener('click', () => {
        if (state.projects.length === 0) {
          showProjects()
          return
        }
        query = ''
        search.value = ''
        selectedProject = ''
        onlyWork = false
        onlyAttention = false
        onlyWorking = false
        workToggle.setAttribute('aria-pressed', 'false')
        attentionToggle.setAttribute('aria-pressed', 'false')
        render()
      })
      nodes.push(reset)
    }
    if (matching.length > limit) {
      const more = el('button', { type: 'button', class: 'chats-show-more' }, 'Show more')
      more.addEventListener('click', () => {
        limit += 40
        render()
      })
      nodes.push(more)
    }
    list.replaceChildren(...nodes)
    if (focusKey) {
      for (const row of list.querySelectorAll<HTMLElement>('[data-entry-key]')) {
        if (row.dataset['entryKey'] === focusKey) row.focus()
      }
    }
  }

  function renderRow(entry: ThreadBrowserEntry, waitingSince: number | undefined): HTMLElement {
    const { thread, project } = entry
    const selected =
      store.getState().activeProjectId === project.id &&
      store.getState().activeThreadId === thread.id
    const row = el('button', {
      type: 'button',
      class: `chat-row thread-browser-row${selected ? ' selected' : ''}`,
      'data-thread-id': thread.id,
      'data-entry-key': threadEntryKey(entry),
      'aria-pressed': String(selected),
    })
    const title = el(
      'span',
      { class: 'chat-title', title: thread.title || 'New thread' },
      thread.title || 'New thread',
    )
    const timing = timings.runs.get(thread.id)
    const updated = thread.updatedAt ?? thread.createdAt
    const timestamp = waitingSince ?? (thread.status === 'running' ? timing?.startedAt : updated)
    const ageKind =
      waitingSince !== undefined
        ? 'Waiting since'
        : thread.status === 'running'
          ? 'Running since'
          : 'Updated'
    const age = el(
      'span',
      {
        class: 'thread-browser-age',
        title:
          timestamp === undefined
            ? 'Time unavailable'
            : `${ageKind} ${new Date(timestamp).toLocaleString()}`,
      },
      timestamp === undefined ? '—' : formatAge(Date.now() - timestamp),
    )
    const summary = data.summary(entry)
    const workLabel = summary
      ? `${String(summary.count)} ${summary.count === 1 ? 'file' : 'files'}`
      : summary === null
        ? '—'
        : '…'
    const changes = el(
      'span',
      {
        class: 'thread-browser-work',
        title: summary
          ? `${String(summary.staged)} staged · ${String(summary.unstaged)} unstaged · ${String(summary.untracked)} untracked`
          : thread.worktree?.retiredAt != null
            ? 'Retired worktree'
            : summary === null
              ? 'Git status unavailable'
              : 'Checking Git status',
      },
      fileTextIcon('ui-icon ui-icon-sm'),
      workLabel,
    )
    changes.hidden = summary?.count === 0
    const approval = sources.approvals.pending().find((request) => request.threadId === thread.id)
    const question = sources.questions.pending().find((request) => request.threadId === thread.id)
    const stateLabel = approval
      ? `Approval · ${approval.title}`
      : question
        ? `Question · ${question.questions[0] ?? 'Needs an answer'}`
        : thread.status === 'running'
          ? 'Working'
          : thread.status === 'error'
            ? 'Failed'
            : thread.unreadAt
              ? 'Finished · unread'
              : (thread.gitBranch ?? (thread.worktree ? 'Ready' : 'Shared checkout'))
    const metadata = el('span', { class: 'thread-browser-meta', title: stateLabel }, stateLabel)
    const glyph = question
      ? messageQuestionIcon
      : approval || waitingSince !== undefined
        ? handIcon
        : thread.status === 'running'
          ? runningStatusIcon
          : thread.status === 'error'
            ? warningIcon
            : checkIcon
    row.dataset['state'] = waitingSince !== undefined ? 'waiting' : thread.status
    row.append(
      glyph('ui-icon thread-browser-glyph'),
      el(
        'span',
        { class: 'thread-browser-row-content' },
        el('span', { class: 'thread-browser-title-line' }, title, age),
        el(
          'span',
          { class: 'thread-browser-subtitle' },
          metadata,
          changes,
          el(
            'span',
            { class: 'thread-browser-project', title: projectDisplayName(project) },
            projectDisplayName(project),
          ),
        ),
      ),
    )
    row.addEventListener('click', () => {
      switchProjectThread(store, api, project.id, thread.id)
    })
    return row
  }

  const refreshSoon = (): void => {
    if (refreshTimer !== undefined) return
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      data.inspect(data.entries(), true)
      scheduleRender()
    }, 1000)
  }
  const unsubs = [
    store.on('projects_changed', scheduleRender),
    store.on('threads_changed', scheduleRender),
    store.on('workspace_changed', scheduleRender),
    store.on('thread_status_changed', scheduleRender),
    sources.approvals.onChange(scheduleRender),
    sources.questions.onChange(scheduleRender),
    api.git.onWorkingTreeChanged(refreshSoon),
  ]
  const ageTimer = setInterval(scheduleRender, 30_000)
  render()
  return () => {
    disposed = true
    if (frame !== undefined) cancelAnimationFrame(frame)
    clearTimeout(refreshTimer)
    clearInterval(ageTimer)
    data.dispose()
    timings.dispose()
    disposeProjects?.()
    for (const unsub of unsubs) unsub()
    root.replaceChildren()
  }
}
