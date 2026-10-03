import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { openNewThread, setThreadTitle } from '@shared/store/thread-helpers.ts'
import { el } from '../dom/helpers.ts'
import { dismissContextMenu, showContextMenu, type ContextMenuEntry } from '../dom/context-menu.ts'
import { bindRenameBlur } from '../dom/rename-blur.ts'
import {
  arrowDownIcon,
  checkIcon,
  chevronDownIcon,
  fileTextIcon,
  messageQuestionIcon,
  moreHorizontalIcon,
  plusIcon,
  runningStatusIcon,
  searchIcon,
  shieldIcon,
  warningIcon,
} from '../dom/icons.ts'
import { formatAge, trackRunTimings } from '../controller/activity-model.ts'
import {
  createThreadBrowserData,
  threadEntryKey,
  type ThreadBrowserEntry,
} from '../controller/thread-browser.ts'
import { createThreadFilter, filterText } from '../controller/thread-filter.ts'
import {
  addProject,
  addRemoteProject,
  createNewProject,
  isProjectSwitchInFlight,
  projectDisplayName,
  switchProjectThread,
} from '../controller/projects.ts'
import { isSshWorkspaceEnabled } from '../controller/ssh-workspace-ui.ts'
import { maybeRenameThreadBranch } from '../controller/thread-naming.ts'
import { mountProjectsPane } from './projects-pane.ts'
import { openActivityPanel, type ActivitySources } from './activity-panel.ts'
import { openAutomationDialog } from './automation-dialog.ts'
import { openSettingsDialog } from './settings-dialog.ts'
import { showErrorToast } from './toast.ts'
import {
  chatPrStatus,
  createPrBackfill,
  createPrStatusTracker,
  type PrBackfillRow,
} from './thread-pr-chips.ts'
import { createRecoverableThreads, renderMissingNotice } from './recoverable-threads.ts'
import { projectMenuEntries, showProjectMenu, threadMenuEntries } from './sidebar-actions.ts'

type ThreadGroup = 'needs-you' | 'working' | 'changes' | 'threads'
type SortColumn = 'activity' | 'updated' | 'title' | 'work'

/** Coalesce working-tree events before re-reading the checkouts they name. */
const WORKING_TREE_EVENT_DELAY_MS = 1000

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
  const changedRoots = new Set<string>()
  let selectedProject = ''
  let query = ''
  let onlyWork = false
  let onlyAttention = false
  let onlyWorking = false
  let sort: SortColumn = 'activity'
  let ascending = false
  let limit = 40
  let sshWorkspaceEnabled = false
  // Inline rename state survives `render()`, which rebuilds every row.
  let renaming: { key: string; threadId: string; draft: string } | null = null
  // Markup of the list as last rendered; an identical render keeps the live rows.
  let renderedSignature = ''
  const collapsed = new Set<string>()
  const timings = trackRunTimings(store, Date.now)
  const data = createThreadBrowserData(store, api, scheduleRender)
  const prStatus = createPrStatusTracker(api, scheduleRender)
  const prBackfill = createPrBackfill(api)
  const recoverable = createRecoverableThreads(store, api, scheduleRender)
  // Matches the search against saved requests in every listed project, not
  // just titles; the active project's resident messages are read in place.
  const requestFilter = createThreadFilter(store, api, scheduleRender, () =>
    data
      .entries()
      .filter((entry) => !selectedProject || entry.project.id === selectedProject)
      .sort((left, right) => (right.thread.updatedAt ?? 0) - (left.thread.updatedAt ?? 0))
      .map((entry) => ({ projectId: entry.project.id, thread: entry.thread })),
  )

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
    // Recovering or dismissing a store there does not change the project set.
    recoverable.refresh()
    render()
  })
  const manage = el('button', { type: 'button', class: 'thread-browser-manage' }, 'Projects')
  manage.addEventListener('click', showProjects)

  function clearFilters(): void {
    query = ''
    search.value = ''
    requestFilter.cancel()
    selectedProject = ''
    onlyWork = false
    onlyAttention = false
    onlyWorking = false
  }

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
      clearFilters()
      openNewThread(store)
    }
  })
  const more = el(
    'button',
    {
      type: 'button',
      class: 'thread-browser-more',
      'aria-label': 'More actions',
      'aria-haspopup': 'menu',
      'data-tooltip': 'Add a project, automations and activity',
    },
    moreHorizontalIcon('ui-icon ui-icon-sm'),
  )
  more.addEventListener('click', () => {
    const rect = more.getBoundingClientRect()
    showContextMenu(rect.right - 4, rect.bottom + 4, [
      {
        label: 'New project',
        onSelect: (): void => {
          void createNewProject(store, api)
        },
      },
      {
        label: 'Open folder',
        onSelect: (): void => {
          void addProject(store, api)
        },
      },
      ...(sshWorkspaceEnabled
        ? [
            {
              label: 'Open remote project',
              onSelect: (): void => {
                void addRemoteProject(store, api).catch((err: unknown) => {
                  showErrorToast('Could not open remote folder', err)
                })
              },
            },
          ]
        : []),
      {
        label: 'New automation…',
        disabled: !store.getState().activeProjectId,
        onSelect: (): void => {
          openAutomationDialog(store, api, { createNew: true })
        },
      },
      {
        label: 'Activity',
        onSelect: (): void => {
          openActivityPanel()
        },
      },
    ])
  })
  const syncRemoteOpenAvailability = (): void => {
    void isSshWorkspaceEnabled(api).then((enabled) => {
      sshWorkspaceEnabled = enabled
    })
  }
  syncRemoteOpenAvailability()

  const totalCount = el('span', { class: 'thread-browser-total' })
  const header = el(
    'div',
    { class: 'thread-browser-heading' },
    el('h2', {}, 'Threads'),
    totalCount,
    el('span', { class: 'thread-browser-heading-actions' }, more, newThread),
  )
  const search = el('input', {
    type: 'search',
    class: 'thread-browser-search-input',
    'aria-label': 'Find threads',
    placeholder: 'Search titles and requests…',
    spellcheck: 'false',
    autocomplete: 'off',
  })
  search.addEventListener('input', () => {
    query = filterText(search.value.trim())
    requestFilter.search(query)
    limit = 40
    render()
  })
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !search.value) return
    event.stopPropagation()
    search.value = ''
    query = ''
    requestFilter.cancel()
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
    if (query) requestFilter.search(query)
    render()
  })
  const projectMenu = el(
    'button',
    {
      type: 'button',
      class: 'thread-browser-project-menu',
      'aria-haspopup': 'menu',
    },
    moreHorizontalIcon('ui-icon ui-icon-sm'),
  )
  projectMenu.addEventListener('click', () => {
    const project = store.getState().projects.find((item) => item.id === selectedProject)
    if (!project) return
    projectMenu.disabled = true
    void showProjectMenu(
      store,
      api,
      project,
      projectMenu,
      projectMenuEntries(store, api, project),
    ).finally(() => {
      projectMenu.disabled = !selectedProject
    })
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
    recoverable.refresh()
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
      el('div', { class: 'thread-browser-scope' }, projectSelect, projectMenu),
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

  function beginRename(entry: ThreadBrowserEntry): void {
    renaming = {
      key: threadEntryKey(entry),
      threadId: entry.thread.id,
      draft: entry.thread.title || 'New thread',
    }
    render()
    const input = list.querySelector<HTMLInputElement>('.chat-title-rename')
    input?.focus()
    input?.select()
  }

  function finishRename(save: boolean): void {
    if (!renaming) return
    const { threadId, draft, key } = renaming
    renaming = null
    const next = draft.trim()
    if (save && next) {
      setThreadTitle(store, threadId, next)
      maybeRenameThreadBranch(store, api, threadId)
    }
    render()
    for (const row of list.querySelectorAll<HTMLElement>('[data-entry-key]')) {
      if (row.dataset['entryKey'] === key) row.focus()
    }
  }

  function renderNotices(): HTMLElement[] {
    const nodes: HTMLElement[] = []
    const missing = store
      .getState()
      .projects.filter(
        (project) => project.missing && (!selectedProject || project.id === selectedProject),
      )
    for (const project of missing) {
      nodes.push(
        el(
          'section',
          { class: 'thread-browser-notice', 'data-project-id': project.id },
          el(
            'div',
            { class: 'thread-browser-notice-heading' },
            warningIcon('ui-icon ui-icon-sm'),
            el('span', {}, projectDisplayName(project)),
          ),
          renderMissingNotice(store, api, project),
        ),
      )
    }
    const recovery = recoverable.section()
    if (recovery) nodes.push(recovery)
    return nodes
  }

  function render(): void {
    if (disposed) return
    // Rebuilding the list would replace an open rename input, dropping its
    // focus or committing it through blur. Finishing the rename renders again.
    if (renaming && list.querySelector('.chat-title-rename')) return
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
    const scopedProject = state.projects.find((project) => project.id === selectedProject)
    // Only a chosen project has a menu; with all projects listed the control would be inert.
    projectMenu.hidden = !scopedProject
    projectMenu.disabled = !scopedProject
    projectMenu.setAttribute(
      'aria-label',
      scopedProject
        ? `Project menu for ${projectDisplayName(scopedProject)}`
        : 'Project menu (choose a project first)',
    )
    projectMenu.title = scopedProject ? 'Project menu' : 'Choose a project to manage it'
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
          ).includes(query) ||
          requestFilter.matches.has(entry.thread.id)) &&
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
    const waitingCount = all.filter((entry) => waiting.has(entry.thread.id)).length
    attentionToggle.textContent = `${String(waitingCount)} need you`
    attentionToggle.classList.toggle('is-empty', waitingCount === 0)
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
    const searching = Boolean(query) && (requestFilter.pending || requestFilter.waiting)
    status.textContent = `${String(matching.length)} ${matching.length === 1 ? 'thread' : 'threads'}${
      searching
        ? ' · Searching requests…'
        : data.pending()
          ? ' · Checking…'
          : data.failed()
            ? ' · Some projects unavailable'
            : query && requestFilter.failed
              ? ' · Some requests could not be searched'
              : unknown > 0 && onlyWork
                ? ` · ${String(unknown)} unavailable`
                : ''
    }`
    // Rebuilding the list would drop keyboard focus; note what had it.
    const active = document.activeElement
    const focusKey =
      active instanceof HTMLElement && list.contains(active)
        ? (active.closest<HTMLElement>('[data-entry-key]')?.dataset['entryKey'] ??
          active.closest<HTMLElement>('[data-group-heading]')?.dataset['groupHeading'] ??
          (active === workToggle ? 'work-toggle' : undefined))
        : undefined
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
    const nodes: HTMLElement[] = renderNotices()
    const backfillRows: PrBackfillRow[] = []
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
          'data-group-heading': key,
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
        for (const entry of group.rows.slice(0, remaining)) {
          const row = renderRow(entry, waiting.get(entry.thread.id))
          if (entry.thread.prRefs === undefined) {
            backfillRows.push({ row, projectId: entry.project.id, threadId: entry.thread.id })
          }
          section.append(row)
        }
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
          data.pending() || searching
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
        clearFilters()
        render()
      })
      nodes.push(reset)
    }
    if (matching.length > limit) {
      const showMore = el('button', { type: 'button', class: 'chats-show-more' }, 'Show more')
      showMore.addEventListener('click', () => {
        limit += 40
        render()
      })
      nodes.push(showMore)
    }
    // Most updates (a Git read landing, a streamed token) change nothing this
    // list shows. Keeping the live rows then preserves hover, focus and the
    // element a click is already aimed at.
    const signature = nodes.map((node) => node.outerHTML).join('\n')
    if (signature === renderedSignature) {
      const liveHeader = list.querySelector('[data-group="changes"] .thread-browser-group-header')
      if (liveHeader && workToggle.parentElement !== liveHeader) liveHeader.append(workToggle)
      if (focusKey === 'work-toggle') workToggle.focus()
      return
    }
    renderedSignature = signature
    // A live list should never jump: keep the reader's place across rebuilds,
    // including a recoverable store dismissed in place (#3311).
    const scrollTop = list.scrollTop
    list.replaceChildren(...nodes)
    list.scrollTop = scrollTop
    prBackfill.observe(backfillRows)
    if (focusKey === 'work-toggle') workToggle.focus()
    else if (focusKey) {
      for (const node of list.querySelectorAll<HTMLElement>(
        '[data-entry-key], [data-group-heading]',
      )) {
        if (node.dataset['entryKey'] === focusKey || node.dataset['groupHeading'] === focusKey) {
          node.focus()
          break
        }
      }
    }
  }

  function renderRenameRow(entry: ThreadBrowserEntry, draft: string): HTMLElement {
    const input = el('input', {
      type: 'text',
      class: 'chat-title-rename',
      'aria-label': 'Rename thread',
    })
    input.value = draft
    input.addEventListener('input', () => {
      if (renaming) renaming.draft = input.value
    })
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter') {
        event.preventDefault()
        finishRename(true)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        finishRename(false)
      }
    })
    bindRenameBlur(input, () => {
      if (renaming?.key !== threadEntryKey(entry)) return
      finishRename(true)
    })
    return el(
      'div',
      {
        class: 'chat-row thread-browser-row is-renaming',
        'data-thread-id': entry.thread.id,
      },
      checkIcon('ui-icon thread-browser-glyph'),
      el('span', { class: 'thread-browser-row-content' }, input),
    )
  }

  function renderRow(entry: ThreadBrowserEntry, waitingSince: number | undefined): HTMLElement {
    const { thread, project } = entry
    if (renaming?.key === threadEntryKey(entry)) return renderRenameRow(entry, renaming.draft)
    const state = store.getState()
    const isActiveProject = state.activeProjectId === project.id
    const selected = isActiveProject && state.activeThreadId === thread.id
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
        ? shieldIcon
        : thread.status === 'running'
          ? runningStatusIcon
          : thread.status === 'error'
            ? warningIcon
            : checkIcon
    row.dataset['state'] = waitingSince !== undefined ? 'waiting' : thread.status
    // The same state hooks the project manager's rows carry.
    row.classList.toggle('is-running', thread.status === 'running')
    row.classList.toggle('is-unread', thread.unreadAt !== undefined && !selected)
    row.classList.toggle('needs-attention', waitingSince !== undefined)
    const titleLine = el('span', { class: 'thread-browser-title-line' }, title)
    const prRollup = prStatus.rollup(thread)
    if (prRollup) {
      row.classList.add('has-pr-status')
      titleLine.append(
        chatPrStatus(prRollup, prRollup.kind === 'open' && prStatus.ciFailing(thread)),
      )
    }
    titleLine.append(age)
    row.append(
      glyph('ui-icon thread-browser-glyph'),
      el(
        'span',
        { class: 'thread-browser-row-content' },
        titleLine,
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
    const open = (): void => {
      switchProjectThread(store, api, project.id, thread.id)
    }
    row.addEventListener('click', open)
    if (isActiveProject) {
      title.addEventListener('dblclick', (event) => {
        event.stopPropagation()
        beginRename(entry)
      })
    }
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const entries: ContextMenuEntry[] = threadMenuEntries(store, api, {
        project,
        thread,
        at: { x: event.clientX, y: event.clientY },
        allowRename: true,
        allowDelete: true,
        onRename: () => {
          beginRename(entry)
        },
        onOpen: open,
      })
      showContextMenu(event.clientX, event.clientY, entries)
    })
    return row
  }

  // Main reports which checkout changed. Only threads on that checkout are
  // re-read; everything else keeps its last status until it ages out.
  const workingTreeChanged = (changedRoot: string): void => {
    changedRoots.add(changedRoot)
    if (refreshTimer !== undefined) return
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      const roots = [...changedRoots]
      changedRoots.clear()
      for (const item of roots) data.invalidateRoot(item)
      scheduleRender()
    }, WORKING_TREE_EVENT_DELAY_MS)
  }
  const unsubs = [
    store.on('projects_changed', scheduleRender),
    store.on('threads_changed', scheduleRender),
    store.on('workspace_changed', scheduleRender),
    store.on('thread_status_changed', scheduleRender),
    store.on('settings_changed', syncRemoteOpenAvailability),
    sources.approvals.onChange(scheduleRender),
    sources.questions.onChange(scheduleRender),
    api.git.onWorkingTreeChanged(workingTreeChanged),
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
    requestFilter.cancel()
    prBackfill.dispose()
    prStatus.reset()
    recoverable.dispose()
    dismissContextMenu()
    disposeProjects?.()
    for (const unsub of unsubs) unsub()
    root.replaceChildren()
  }
}
