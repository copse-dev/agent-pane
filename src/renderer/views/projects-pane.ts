import { openAppRunDialog } from './app-run-dialog.ts'
import { withoutSideChats } from '@shared/threads/side-chat.ts'
import type { ThreadLiveResources } from '@shared/threads/archive-thread.ts'
import { el, clear } from '../dom/helpers.ts'
import {
  contextMenuClosedByPressOn,
  dismissContextMenu,
  showContextMenu,
  type ContextMenuEntry,
} from '../dom/context-menu.ts'
import { bindRenameBlur } from '../dom/rename-blur.ts'
import { prHasMergeConflicts } from '../dom/pr-status.ts'
import {
  bellIcon,
  chevronDownIcon,
  chevronRightIcon,
  gitMergeIcon,
  gitBranchIcon,
  gitPullRequestIcon,
  moreHorizontalIcon,
  moreVerticalIcon,
  plusIcon,
  runningStatusIcon,
  searchIcon,
  warningIcon,
} from '../dom/icons.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { OrphanProjectStore, Project, ProjectGroup } from '@shared/types'
import type { GhPrChecksState, ThreadChangeSummary } from '@shared/types/git.ts'
import {
  describeThreadChanges,
  sameThreadChangeSummary,
} from '@shared/git/thread-change-summary.ts'
import {
  archiveThread,
  deleteThread,
  isThreadArchived,
  openNewThread,
  setThreadTitle,
} from '@shared/store/thread-helpers.ts'
import { githubPrKey, type GithubPrRef } from '@shared/git/github-pr-url.ts'
import {
  describeThreadPrStatus,
  normalizePrLifecycleState,
  summarizeThreadPrStatus,
  type PrLifecycleState,
  type ThreadPrRollup,
} from '@shared/git/thread-pr-status.ts'
import {
  addProject,
  archiveCachedSidebarThread,
  addRemoteProject,
  createNewProject,
  getSidebarThreads,
  getSideChatUnreadParents,
  isProjectSwitchInFlight,
  dismissOrphanProject,
  listOrphanProjects,
  paginateSidebarThreads,
  projectDisplayName,
  removeProject,
  recoverOrphanProject,
  relocateProject,
  SIDEBAR_THREADS_PAGE_SIZE,
  switchProject,
  switchProjectThread,
} from '../controller/projects.ts'
import { openSettingsDialog } from './settings-dialog.ts'
import { hasAutomationDialog, openAutomationDialog } from './automation-dialog.ts'
import { ipcErrorMessage } from '../ipc-error-message.ts'
import { showConfirmDialog } from './confirm-dialog.ts'
import { showErrorToast, showToast } from './toast.ts'
import { forkThread } from '../controller/fork-thread.ts'
import {
  createThreadFilter,
  filterText,
  residentRequestMatches,
} from '../controller/thread-filter.ts'
import { sortThreadsNewestFirst } from '@copse/thread-store/thread-sort.ts'
import {
  groupRowsByStatus,
  orderSidebarRows,
  orderSidebarThreads,
  type SidebarRow,
} from '../controller/thread-order.ts'
import {
  THREAD_SORT_MODES,
  type ThreadGroupMode,
  type ThreadSortMode,
} from '@shared/types/state.ts'
import { sidebarPrRefs, type SidebarThread } from '../controller/sidebar-thread.ts'
import { getAttentionThreadIds, isThreadAwaitingAttention } from '../controller/attention.ts'
import { openActivityPanel } from './activity-panel.ts'
import { openThreadHistoryEditor } from './thread-history-editor.ts'
import { foldAutomationRuns } from '../controller/automation-fold.ts'
import { isSshWorkspaceEnabled } from '../controller/ssh-workspace-ui.ts'
import { maybeRenameThreadBranch } from '../controller/thread-naming.ts'
import { flushProjectThreads } from '../controller/persistence.ts'
import {
  buildProjectTree,
  projectGroupId,
  type SidebarNodeRef,
} from '../controller/project-tree.ts'
import {
  createProjectGroup,
  deleteProjectGroup,
  moveProjectIntoGroup,
  renameProjectGroup,
  reorderSidebarNode,
  setProjectGroupCollapsed,
} from '../controller/project-groups.ts'
import {
  dropIntent,
  isSidebarDrag,
  parseSidebarDrag,
  serializeSidebarDrag,
  SIDEBAR_DRAG_MIME,
  type DropIntent,
  type SidebarDragPayload,
} from './projects-drag.ts'

/** Re-fetch PR lifecycle when a cache entry is older than this. */
const PR_STATUS_CACHE_TTL_MS = 60_000

const ICON_SIZE = '16'
const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Small bell shown on a thread (or collapsed project) that is waiting on the
 * user while it isn't the focused thread — e.g. a background run hit a shell
 * approval or an `ask_user` question. Draws the eye to work that would
 * otherwise be silently blocked in another project/thread.
 */
export function describeLiveResources(running: ThreadLiveResources): string[] {
  return [
    ...(running.agent ? ['• the chat’s running agent'] : []),
    ...(running.terminals ? ['• its open terminals'] : []),
    ...(running.backgroundProcesses ? ['• its background processes'] : []),
  ]
}

function attentionBell(label: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'chat-attention-bell')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', label)
  svg.setAttribute('data-tooltip', label)
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('fill', 'currentColor')
  path.setAttribute(
    'd',
    'M12 2a1 1 0 0 1 1 1v.6a6 6 0 0 1 5 5.9v3l1.4 2.9A1 1 0 0 1 18.5 17h-13a1 1 0 0 1-.9-1.6L6 12.5v-3a6 6 0 0 1 5-5.9V3a1 1 0 0 1 1-1Zm0 20a2.5 2.5 0 0 1-2.45-2h4.9A2.5 2.5 0 0 1 12 22Z',
  )
  svg.append(path)
  return svg
}

/**
 * Animated "…" to the left of a running thread's title — same three-dot glyph
 * used for overflow elsewhere, with opacity walking across the dots.
 */
function runningStatus(label: string): SVGSVGElement {
  const svg = runningStatusIcon('ui-icon chat-running-status')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', label)
  svg.setAttribute('data-tooltip', label)
  svg.removeAttribute('aria-hidden')
  return svg
}

/** Single GitHub PR icon on a thread row; color encodes open / merged / closed. */
function chatPrStatus(rollup: ThreadPrRollup, ciFailing: boolean, conflicts: boolean): HTMLElement {
  const statusLabel = ciFailing
    ? `${describeThreadPrStatus(rollup)}; checks are failing`
    : describeThreadPrStatus(rollup)
  const label = conflicts ? `${statusLabel}; merge conflicts` : statusLabel
  const icon =
    rollup.kind === 'merged'
      ? gitMergeIcon('ui-icon ui-icon-sm')
      : gitPullRequestIcon('ui-icon ui-icon-sm', conflicts)
  icon.setAttribute('aria-hidden', 'true')
  return el(
    'span',
    {
      class: `chat-pr-status is-${rollup.kind}${conflicts ? ' has-conflicts' : ciFailing ? ' has-ci-failure' : ''}`,
      role: 'img',
      'aria-label': label,
      'data-tooltip': label,
    },
    icon,
  )
}

/** Muted branch glyph for a finished thread with unlanded work and no PR; detail is tooltip-only. */
function chatChangesStatus(label: string): HTMLElement {
  const icon = gitBranchIcon('ui-icon ui-icon-sm')
  icon.setAttribute('aria-hidden', 'true')
  return el(
    'span',
    { class: 'chat-changes-status', role: 'img', 'aria-label': label, 'data-tooltip': label },
    icon,
  )
}

function settingsIcon(className = 'titlebar-btn-icon'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', className)
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', ICON_SIZE)
  svg.setAttribute('height', ICON_SIZE)
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('data-icon', 'settings')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute(
    'd',
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z' +
      'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1Z',
  )
  svg.append(path)
  return svg
}

/**
 * Trailing link on an automation heading through to that automation's setup —
 * the in-place `automation-dialog`, never the packs/settings page. Quiet until
 * its heading is hovered or the button takes focus, like the row actions
 * beside it. Defaults to the settings gear (open this automation's editor);
 * the workspace heading's "New automation…" action reuses the same quiet
 * chrome with a plus glyph instead.
 */
function automationSetupBtn(
  label: string,
  open: () => void,
  icon: (className?: string) => SVGSVGElement = settingsIcon,
): HTMLElement {
  const btn = el(
    'button',
    { type: 'button', class: 'automation-setup-btn', 'aria-label': label, title: label },
    icon('ui-icon ui-icon-sm'),
  )
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    open()
  })
  return btn
}

/** One schedule's run/setup actions, addressed the way the sidebar groups are. */
interface AutomationMenuTarget {
  project: Project
  scheduleName: string
  scheduleId: string
}

/**
 * Fire a schedule immediately through the same IPC the editor's Run-now
 * button uses. The outcome surfaces as a toast: this runs from a menu that
 * has already closed, so unlike the editor there is no inline status element
 * to write into. A coalesced run says why, as the editor's status line does.
 */
function startRunNow(api: ApiClient, target: AutomationMenuTarget): void {
  void api.automations
    .runNow(target.project.id, target.scheduleId)
    .then((event) => {
      showToast(
        event.disposition === 'started'
          ? `Started “${target.scheduleName}”.`
          : event.coalescedReason === 'worktree-limit'
            ? `“${target.scheduleName}” has reached its live worktree limit.`
            : `“${target.scheduleName}” is already pending or running.`,
      )
    })
    .catch((error: unknown) => {
      showErrorToast(
        `Could not run “${target.scheduleName}”`,
        ipcErrorMessage(error, 'The run could not start'),
      )
    })
}

/**
 * One schedule's shared right-click actions, rendered on the sidebar's
 * schedule headings. "Run now" is the editor's Run-now button, reached
 * without opening the dialog.
 */
function automationMenuEntries(
  api: ApiClient,
  target: AutomationMenuTarget,
  openSetup: () => void,
): ContextMenuEntry[] {
  return [
    { heading: target.scheduleName },
    {
      label: 'Run now',
      onSelect: (): void => {
        startRunNow(api, target)
      },
    },
    {
      label: 'Automation setup…',
      onSelect: openSetup,
    },
  ]
}

/** The prototype lists Status first; the shared tuple keeps its own order. */
const GROUP_MENU_ORDER: readonly ThreadGroupMode[] = ['status', 'project', 'none']

export function mountProjectsPane(root: HTMLElement, store: AppStore, api: ApiClient): () => void {
  // The sidebar's thread list is narrowed from two rows at its top, as in the prototype:
  // the search field with the Activity bell and "+" beside it, then the project
  // filter and the sort and grouping choice.
  // One "+" entry point for every way to add a project. The remote action is
  // included only while SSH workspaces are enabled.
  const addBtn = el(
    'button',
    {
      class: 'projects-add-btn',
      'aria-label': 'Add project',
      'data-tooltip': 'New thread, new project or open a folder',
    },
    plusIcon('ui-icon ui-icon-sm'),
  )
  // The sidebar's bells mark each waiting thread in place; this one gathers
  // them — and everything running — into the Activity panel (Cmd/Ctrl+Shift+A).
  const activityCount = el('span', { class: 'projects-activity-count', hidden: true })
  const activityBtn = el(
    'button',
    {
      class: 'projects-activity-btn',
      'aria-label': 'Activity',
      'data-tooltip': 'Activity: what needs you and what is running',
    },
    bellIcon('ui-icon ui-icon-sm'),
    activityCount,
  )
  activityBtn.addEventListener('click', () => {
    openActivityPanel()
  })
  const syncActivityButton = (): void => {
    const waiting = getAttentionThreadIds().length
    activityBtn.classList.toggle('has-attention', waiting > 0)
    activityCount.hidden = waiting === 0
    activityCount.textContent = waiting > 0 ? String(waiting) : ''
    activityBtn.setAttribute(
      'aria-label',
      waiting === 0
        ? 'Activity'
        : `Activity: ${String(waiting)} ${waiting === 1 ? 'thread needs' : 'threads need'} you`,
    )
  }
  syncActivityButton()

  // Filter input for the expanded project's threads. It lives outside `list`
  // (which render() clears on every update) so its focus and value survive
  // re-renders while the user is typing.
  let threadFilter = ''
  // The workspace whose threads the open filter is narrowing.
  let filteredProjectId = store.getState().activeProjectId
  // Scan progress can report a match per transcript; coalesce those into one
  // sidebar render per frame.
  let renderFrameQueued = false
  const contentFilter = createThreadFilter(store, api, () => {
    if (renderFrameQueued) return
    renderFrameQueued = true
    requestAnimationFrame(() => {
      renderFrameQueued = false
      render()
    })
  })
  const searchInput = el('input', {
    type: 'text',
    class: 'projects-search-input',
    placeholder: 'Search…',
    'aria-label': 'Filter threads',
    spellcheck: 'false',
    autocomplete: 'off',
  })
  const searchBox = el(
    'label',
    { class: 'projects-search' },
    searchIcon('ui-icon ui-icon-sm projects-search-icon'),
    searchInput,
  )
  const header = el('div', { class: 'pane-projects-header' }, searchBox, activityBtn, addBtn)

  const closeThreadFilter = (): void => {
    contentFilter.cancel()
    searchInput.value = ''
    threadFilter = ''
  }

  // One line per thread: the owning project's name is dropped. Session-only, like the project filter.
  let compactRows = false
  // Which project the list shows. Session-only: a fresh launch shows them all.
  let projectFilterId: string | null = null
  // Narrow to threads with unlanded work (an open PR, or uncommitted/unpushed
  // changes). Session-only, like the project filter; a thread whose PR/change
  // state hasn't been fetched yet counts as matching so it isn't hidden before
  // its data has loaded (see `threadNeedsCleanup`).
  let needsCleanupOnly = false
  const filterLabel = el('span', { class: 'projects-filter-label' }, 'All projects')
  const projectFilterBtn = el(
    'button',
    { type: 'button', class: 'projects-filter-btn', 'aria-haspopup': 'menu' },
    filterLabel,
    chevronDownIcon('ui-icon ui-icon-sm'),
  )
  // How the threads are ordered and grouped. Both persist per profile; the store
  // keeps its own newest-first order and this only re-sorts what is drawn.
  const sortDir = el('span', { class: 'projects-sort-dir' }, '↓')
  const sortLabel = el('span', { class: 'projects-filter-label' }, 'Activity order')
  const sortBtn = el(
    'button',
    {
      type: 'button',
      class: 'projects-filter-btn projects-sort-btn',
      'aria-haspopup': 'menu',
      'aria-label': 'Group and sort threads',
    },
    sortDir,
    sortLabel,
    chevronDownIcon('ui-icon ui-icon-sm'),
  )
  const filtersRow = el('div', { class: 'projects-filters' }, projectFilterBtn, sortBtn)

  searchInput.addEventListener('input', () => {
    threadFilter = filterText(searchInput.value.trim())
    filteredProjectId = store.getState().activeProjectId
    contentFilter.search(threadFilter)
    render()
  })
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      closeThreadFilter()
      render()
    }
  })

  const list = el('div', { class: 'projects-list' })
  const settingsBtn = el(
    'button',
    { class: 'projects-settings-btn', 'aria-label': 'Settings', 'data-tooltip': 'Open settings' },
    'Settings',
  )
  settingsBtn.addEventListener('click', () => {
    openSettingsDialog()
  })
  root.append(
    header,
    filtersRow,
    list,
    el('div', { class: 'projects-settings-actions' }, settingsBtn),
  )

  let sshWorkspaceEnabled = false

  const SORT_LABELS: Readonly<Record<ThreadSortMode, string>> = {
    activity: 'Activity order',
    created: 'Created',
    title: 'Thread name',
  }
  const GROUP_LABELS: Readonly<Record<ThreadGroupMode, string>> = {
    project: 'Project',
    status: 'Status',
    none: 'None',
  }
  // The menu applies the choice at once; a save that fails would otherwise be lost
  // silently and the order would revert on the next launch.
  const saveSort = (
    key: 'sidebarThreadSort' | 'sidebarThreadSortReverse' | 'sidebarThreadGroup',
    value: ThreadSortMode | ThreadGroupMode | boolean,
  ): void => {
    void api.settings.set(key, value).catch((err: unknown) => {
      showErrorToast('Could not save the thread order', err)
    })
  }
  /** The two filter buttons say what they currently do: which project, and the sort. */
  function syncFilterControls(): void {
    const { projects, sidebarThreadSort, sidebarThreadSortReverse } = store.getState()
    const chosen = projects.find((project) => project.id === projectFilterId)
    if (!chosen) projectFilterId = null
    const projectName = chosen ? projectDisplayName(chosen) : 'All projects'
    filterLabel.textContent = needsCleanupOnly ? `${projectName} · Needs cleanup` : projectName
    projectFilterBtn.classList.toggle('is-filtering', chosen !== undefined || needsCleanupOnly)
    projectFilterBtn.setAttribute(
      'aria-label',
      needsCleanupOnly ? `Show: ${projectName}, needs cleanup only` : `Show: ${projectName}`,
    )
    sortLabel.textContent = SORT_LABELS[sidebarThreadSort]
    // The arrow points the way the list runs: newest, or A first, is down.
    sortDir.textContent = sidebarThreadSortReverse ? '↑' : '↓'
  }
  projectFilterBtn.addEventListener('click', () => {
    if (contextMenuClosedByPressOn(projectFilterBtn)) return
    const rect = projectFilterBtn.getBoundingClientRect()
    const { projects } = store.getState()
    const counts = new Map(
      projects.map((project) => [project.id, getSidebarThreads(store, project.id).length]),
    )
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0)
    showContextMenu(rect.left, rect.bottom + 4, [
      { heading: 'Show' },
      {
        label: 'All projects',
        detail: String(total),
        checked: projectFilterId === null,
        onSelect: (): void => {
          projectFilterId = null
          render()
        },
      },
      ...projects.map((project): ContextMenuEntry => ({
        label: projectDisplayName(project),
        detail: String(counts.get(project.id) ?? 0),
        checked: project.id === projectFilterId,
        onSelect: (): void => {
          projectFilterId = project.id
          render()
        },
      })),
      { separator: true },
      {
        label: 'Needs cleanup only',
        toggle: true,
        checked: needsCleanupOnly,
        onSelect: (): void => {
          needsCleanupOnly = !needsCleanupOnly
          render()
        },
      },
    ])
  })
  sortBtn.addEventListener('click', () => {
    if (contextMenuClosedByPressOn(sortBtn)) return
    const rect = sortBtn.getBoundingClientRect()
    const { sidebarThreadSort, sidebarThreadSortReverse, sidebarThreadGroup } = store.getState()
    showContextMenu(rect.right - 4, rect.bottom + 4, [
      { heading: 'Group by' },
      ...GROUP_MENU_ORDER.map((mode): ContextMenuEntry => ({
        label: GROUP_LABELS[mode],
        checked: mode === sidebarThreadGroup,
        onSelect: (): void => {
          store.setState({ sidebarThreadGroup: mode })
          saveSort('sidebarThreadGroup', mode)
          render()
        },
      })),
      { heading: 'Sort by' },
      ...THREAD_SORT_MODES.map((mode): ContextMenuEntry => ({
        label: SORT_LABELS[mode],
        checked: mode === sidebarThreadSort,
        onSelect: (): void => {
          store.setState({ sidebarThreadSort: mode })
          saveSort('sidebarThreadSort', mode)
          render()
        },
      })),
      { separator: true },
      {
        label: 'Reverse order',
        toggle: true,
        checked: sidebarThreadSortReverse,
        onSelect: (): void => {
          store.setState({ sidebarThreadSortReverse: !sidebarThreadSortReverse })
          saveSort('sidebarThreadSortReverse', !sidebarThreadSortReverse)
          render()
        },
      },
      {
        label: 'Compact rows',
        toggle: true,
        checked: compactRows,
        onSelect: (): void => {
          compactRows = !compactRows
          list.classList.toggle('is-compact', compactRows)
        },
      },
    ])
  })

  addBtn.addEventListener('click', () => {
    if (contextMenuClosedByPressOn(addBtn)) return
    const rect = addBtn.getBoundingClientRect()
    showContextMenu(rect.right - 4, rect.bottom + 4, [
      {
        label: 'New thread',
        onSelect: (): void => {
          if (!store.getState().workspaceRoot) {
            void addProject(store, api)
            return
          }
          openNewThread(store)
        },
      },
      { separator: true },
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
        label: 'New group',
        onSelect: (): void => {
          const groupId = createProjectGroup(store, api)
          const created = store.getState().projectGroups.find((g) => g.id === groupId)
          if (created) beginGroupRename(groupId, created.name)
        },
      },
    ])
  })

  const syncRemoteOpenAvailability = (): void => {
    void isSshWorkspaceEnabled(api).then((enabled) => {
      sshWorkspaceEnabled = enabled
      addBtn.setAttribute(
        'data-tooltip',
        enabled
          ? 'New project, open a folder, or connect remotely'
          : 'New project or open a folder',
      )
    })
  }
  syncRemoteOpenAvailability()
  store.on('settings_changed', syncRemoteOpenAvailability)

  const visibleThreadCounts = new Map<string, number>()
  const prBackfillRequested = new Map<string, Set<string>>()
  const prBackfillRetryAttempts = new Map<string, number>()
  const prBackfillRetryTimers = new Set<ReturnType<typeof setTimeout>>()
  let prBackfillRowsByKey = new Map<string, Element>()
  let prBackfillObserver: IntersectionObserver | null = null
  // Sidebar "changes" glyph: per-thread unlanded-work summaries, fetched once the
  // rows are drawn. A read per working-tree event would be 40 reads for one event
  // (#3386), so only the active thread follows those events; the rest age out.
  const THREAD_CHANGE_TTL_MS = 30_000
  const THREAD_CHANGE_MAX_PER_PASS = 60
  const threadChangeCache = new Map<string, { summary: ThreadChangeSummary | null; at: number }>()
  const threadChangeInFlight = new Set<string>()
  let threadChangeGeneration = 0
  let threadChangeTimer: ReturnType<typeof setTimeout> | null = null
  const threadChangeKey = (projectId: string, threadId: string): string =>
    `${projectId}\0${threadId}`

  // Rows drawn by the latest render, so an idle sidebar can re-check them.
  let threadChangeRendered: Array<{ projectId: string; threadId: string }> = []

  function refreshThreadChanges(
    refs: Array<{ projectId: string; threadId: string }>,
    opts: { fresh?: boolean } = {},
  ): void {
    const batch = refs
      .filter((ref) => !threadChangeInFlight.has(threadChangeKey(ref.projectId, ref.threadId)))
      .slice(0, THREAD_CHANGE_MAX_PER_PASS)
    if (batch.length === 0) return
    const generation = threadChangeGeneration
    for (const ref of batch) threadChangeInFlight.add(threadChangeKey(ref.projectId, ref.threadId))
    const settle = (results: Array<ThreadChangeSummary | null>): void => {
      let changed = false
      for (const [i, ref] of batch.entries()) {
        const key = threadChangeKey(ref.projectId, ref.threadId)
        threadChangeInFlight.delete(key)
        const summary = results[i] ?? null
        const previous = threadChangeCache.get(key)
        if (!sameThreadChangeSummary(previous?.summary ?? null, summary)) {
          changed = true
        }
        // The cleanup filter treats a never-checked thread as a match; once its
        // first summary lands the filter must re-evaluate it even when the
        // visible label (null -> null) stayed the same.
        if (needsCleanupOnly && !previous) changed = true
        threadChangeCache.set(key, { summary, at: Date.now() })
      }
      // Only an unmounted pane must not redraw from a late answer.
      if (changed && generation === threadChangeGeneration) render(true)
    }
    void api.git.threadChangeSummary(batch, opts).then(settle, () => {
      settle([])
    })
  }
  // Automation history is collated in one workspace-level section (#2511)
  // rather than tucked inside each project, so it reads as one place to check
  // every schedule regardless of which project it belongs to. Expansion is
  // session-only, same as a project group's twisty before it gained persisted
  // state: a fresh app launch returns to the quiet default, while selecting an
  // automation thread always reveals its owner (the section, and its schedule,
  // open on their own when the active thread is one of theirs).
  let automationsSectionExpanded = false
  const expandedAutomationSchedules = new Set<string>()
  // Schedules whose collated failed runs are opened out into rows. Session-only.
  const expandedFailedSchedules = new Set<string>()
  let orphans: OrphanProjectStore[] = []
  // Project selection and expansion also emit `projects_changed`, but only a
  // change to the project ids can alter which thread stores are orphaned.
  let knownProjectIds = new Set(store.getState().projects.map((project) => project.id))
  let orphanScanGeneration = 0

  // Inline rename state survives `render()` (which rebuilds the chat list).
  let renaming: { threadId: string; draft: string } | null = null
  // Same, for a group header being renamed inline.
  let renamingGroup: { groupId: string; draft: string } | null = null

  /**
   * The sidebar row currently being dragged (issue #1685).
   *
   * `dragover` cannot read the drag payload — the browser withholds it until the
   * drop — so the pane remembers what `dragstart` put there. That is what lets a
   * hovered row decide whether it is a legal target (a group cannot be dropped
   * inside itself) before any drop happens.
   */
  let activeDrag: SidebarDragPayload | null = null

  // Session cache of GitHub PR lifecycle for sidebar chips. Keys are
  // `owner/repo#number`. Fetches are coalesced; stale state stays visible while
  // revalidation runs, and lifecycle changes re-render without blocking first paint.
  const prLifecycleCache = new Map<
    string,
    { state: PrLifecycleState; checks?: GhPrChecksState; conflicts?: boolean; fetchedAt: number }
  >()
  const prFetchInFlight = new Set<string>()
  let prStatusGeneration = 0

  function beginThreadRename(threadId: string, currentTitle: string): void {
    renaming = { threadId, draft: currentTitle || 'New Thread' }
    render()
    const input = list.querySelector<HTMLInputElement>(
      `.chat-row[data-thread-id="${CSS.escape(threadId)}"] .chat-title-rename`,
    )
    input?.focus()
    input?.select()
  }

  function finishThreadRename(save: boolean): void {
    if (!renaming) return
    const { threadId, draft } = renaming
    renaming = null
    const next = draft.trim()
    if (save && next) {
      setThreadTitle(store, threadId, next)
      maybeRenameThreadBranch(store, api, threadId)
    } else {
      render()
    }
  }

  /**
   * Branch the whole conversation into a new thread. Only the active project's
   * threads are in memory (and only its store dir is the fork IPC's subject), so
   * a background project's row switches to it first.
   */
  function forkProjectThread(projectId: string, threadId: string): void {
    if (projectId !== store.getState().activeProjectId) return
    void forkThread(store, api, threadId).then((result) => {
      if (!result) {
        showToast('That thread has no messages to fork.', { variant: 'error' })
        return
      }
      showToast('Forked into a new thread.')
    })
  }

  const archivingThreads = new Set<string>()

  async function archiveProjectThread(projectId: string, threadId: string): Promise<void> {
    // Only the active project's in-memory thread list is mutable here; other
    // projects' rows are cache-backed until switched.
    if (projectId !== store.getState().activeProjectId || archivingThreads.has(threadId)) return
    // Archiving takes a thread's side chats with it, and would hide a running one
    // without stopping its run.
    const runningSideChat = store
      .getState()
      .threads.some(
        (t) =>
          t.sideChat?.parentThreadId === threadId && !isThreadArchived(t) && t.status === 'running',
      )
    if (runningSideChat) {
      showToast('Wait for this chat’s side chat to finish before archiving it.', {
        variant: 'error',
      })
      return
    }
    archivingThreads.add(threadId)
    try {
      await flushProjectThreads(api, projectId, store.getState().threads)
      if (projectId !== store.getState().activeProjectId) return
      let stopProcesses = false
      let result = await api.threads.archive(projectId, threadId, null, stopProcesses)
      if (result.status === 'blocked-running') {
        const title = store.getState().threads.find((t) => t.id === threadId)?.title ?? 'this chat'
        const confirmed = await showConfirmDialog({
          message: `Stop running work and archive “${title}”?`,
          detail: [
            'Archiving will stop:',
            ...describeLiveResources(result.running),
            'Anything still running in the chat’s worktree is ended before it is removed.',
          ].join('\n'),
          confirmLabel: 'Stop and archive',
          danger: true,
        })
        if (!confirmed || projectId !== store.getState().activeProjectId) return
        stopProcesses = true
        result = await api.threads.archive(projectId, threadId, null, stopProcesses)
      }
      let refreshed = false
      while (result.status === 'blocked-dirty') {
        const title = store.getState().threads.find((t) => t.id === threadId)?.title ?? 'this chat'
        const shown = result.paths.slice(0, 10)
        const remaining = result.paths.length - shown.length
        const confirmed = await showConfirmDialog({
          message: `Discard uncommitted files and archive “${title}”?`,
          detail: [
            ...(refreshed
              ? ['Files changed while confirmation was open. Review the current files again.']
              : []),
            'The worktree will be removed. These changes and local files will be permanently discarded:',
            ...shown,
            ...(remaining > 0 ? [`…and ${String(remaining)} more`] : []),
            'The chat history and committed work on its branch will be kept.',
          ].join('\n'),
          confirmLabel: 'Discard and archive',
          danger: true,
        })
        if (!confirmed || projectId !== store.getState().activeProjectId) return
        result = await api.threads.archive(projectId, threadId, result.fingerprint, stopProcesses)
        refreshed = true
      }
      if (result.status === 'blocked-running') {
        showToast('Something started in the chat while archiving. Try again.', {
          variant: 'error',
        })
        return
      }
      if (projectId === store.getState().activeProjectId) archiveThread(store, threadId, result)
      else {
        archiveCachedSidebarThread(projectId, threadId, result.archivedAt)
        render()
      }
    } catch (error) {
      showErrorToast('Could not archive chat', error)
    } finally {
      archivingThreads.delete(threadId)
    }
  }

  function cachedPrLifecycle(key: string): PrLifecycleState | undefined {
    return prLifecycleCache.get(key)?.state
  }

  function hasFreshPrLifecycle(key: string): boolean {
    const entry = prLifecycleCache.get(key)
    return entry !== undefined && Date.now() - entry.fetchedAt <= PR_STATUS_CACHE_TTL_MS
  }

  function ensurePrLifecycles(refs: GithubPrRef[]): void {
    const stale = refs.filter((ref) => {
      const key = githubPrKey(ref)
      return !hasFreshPrLifecycle(key) && !prFetchInFlight.has(key)
    })
    if (stale.length === 0) return
    const generation = prStatusGeneration
    for (const ref of stale) {
      const key = githubPrKey(ref)
      let lifecycleChanged = false
      prFetchInFlight.add(key)
      void api.gh
        .prDetails(ref.owner, ref.repo, ref.number)
        .then((details) => {
          if (generation !== prStatusGeneration) return
          const state = details ? normalizePrLifecycleState(details.state) : 'unknown'
          const previous = prLifecycleCache.get(key)
          const conflicts = state === 'open' && details !== null && prHasMergeConflicts(details)
          lifecycleChanged = previous?.state !== state || previous.conflicts !== conflicts
          // CI and merge conflicts only affect open PRs.
          prLifecycleCache.set(key, {
            state,
            conflicts,
            ...(state === 'open' && previous?.checks ? { checks: previous.checks } : {}),
            fetchedAt: Date.now(),
          })
          if (state !== 'open') return undefined
          return api.gh.prChecks(ref.owner, ref.repo, ref.number).then((checks) => {
            if (generation !== prStatusGeneration) return
            const entry = prLifecycleCache.get(key)
            if (!entry) return
            if (entry.checks !== checks) lifecycleChanged = true
            prLifecycleCache.set(key, { ...entry, checks })
          })
        })
        .catch(() => {
          if (generation !== prStatusGeneration) return
          const cached = prLifecycleCache.get(key)
          prLifecycleCache.set(key, {
            state: cached?.state ?? 'unknown',
            ...(cached?.conflicts !== undefined ? { conflicts: cached.conflicts } : {}),
            fetchedAt: Date.now(),
          })
        })
        .finally(() => {
          if (generation !== prStatusGeneration) return
          prFetchInFlight.delete(key)
          if (lifecycleChanged) render()
        })
    }
  }

  // A sidebar left idle keeps its glyphs honest after a commit or push elsewhere:
  // the TTL is otherwise only checked when something redraws, so re-check when the
  // window regains focus or becomes visible, which is when someone looks again.
  function recheckStaleThreadChanges(): void {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    const now = Date.now()
    refreshThreadChanges(
      threadChangeRendered.filter(({ projectId, threadId }) => {
        const cached = threadChangeCache.get(threadChangeKey(projectId, threadId))
        return !cached || now - cached.at > THREAD_CHANGE_TTL_MS
      }),
    )
  }

  function ciFailingForThread(thread: SidebarThread): boolean {
    return sidebarPrRefs(thread).some((ref) => {
      const entry = prLifecycleCache.get(githubPrKey(ref))
      return entry?.state === 'open' && entry.checks === 'failure'
    })
  }

  function conflictsForThread(thread: SidebarThread): boolean {
    return sidebarPrRefs(thread).some((ref) => {
      const entry = prLifecycleCache.get(githubPrKey(ref))
      return entry?.state === 'open' && entry.conflicts === true
    })
  }

  function rollupForThread(thread: SidebarThread): ThreadPrRollup | null {
    const refs = sidebarPrRefs(thread)
    if (refs.length === 0) return null
    ensurePrLifecycles(refs)
    const states = refs.map((ref) => cachedPrLifecycle(githubPrKey(ref)) ?? 'unknown')
    return summarizeThreadPrStatus(states, refs)
  }

  /**
   * Unlanded work: an open PR, or uncommitted/unpushed changes. Mirrors the
   * row's own "has-changes-status"/"has-pr-status" badges so the filter agrees
   * with what's on screen. A thread whose PR or change state hasn't been
   * fetched yet counts as matching, not excluded — otherwise toggling the
   * filter on would hide everything until each row happened to scroll into
   * view and backfill (see the IntersectionObserver-gated fetches below).
   */
  function threadNeedsCleanup(project: Project, thread: SidebarThread): boolean {
    if (project.sshHost || thread.status === 'running') return false
    const rollup = rollupForThread(thread)
    if (rollup) return rollup.kind === 'open'
    const cached = threadChangeCache.get(threadChangeKey(project.id, thread.id))
    if (!cached) return true
    return describeThreadChanges(cached.summary) !== null
  }

  // The quarantine notice shown when a project's folder could not be opened
  // (#997). Its threads are still on disk under ~/.copse/workspace/<id>/; the
  // action re-points the project at a folder (local) or retries the open (SSH).
  function renderMissingNotice(project: Project): HTMLElement {
    const wrap = el('div', { class: 'project-missing-notice' })
    wrap.append(
      el(
        'div',
        { class: 'project-missing-text' },
        'This folder could not be opened. Its threads are safe — ' +
          (project.sshHost
            ? 'retry once the host is reachable.'
            : 'relocate the project to restore them.'),
      ),
    )
    const action = project.sshHost
      ? el('button', { type: 'button', class: 'project-missing-btn' }, 'Retry')
      : el('button', { type: 'button', class: 'project-missing-btn' }, 'Relocate…')
    action.addEventListener('click', () => {
      if (project.sshHost) {
        switchProject(store, api, project.id)
        return
      }
      void relocateProject(store, api, project.id).catch((err: unknown) => {
        showErrorToast('Could not relocate project', err)
      })
    })
    wrap.append(action)
    return wrap
  }

  // Orphaned thread stores (dirs with threads but no project entry) surfaced so
  // they can be re-attached instead of recovered by hand (#997).
  function orphanPrimaryLabel(orphan: OrphanProjectStore): string {
    const lead = orphan.sampleTitles[0]?.trim()
    if (lead) return lead
    const count = orphan.threadCount
    return `${String(count)} thread${count === 1 ? '' : 's'}`
  }

  function orphanSubtitle(orphan: OrphanProjectStore): string {
    const count = orphan.threadCount
    const countLabel = `${String(count)} thread${count === 1 ? '' : 's'}`
    const extra = orphan.sampleTitles.slice(1).filter((title) => title.trim().length > 0)
    if (extra.length === 0) return countLabel
    const shown = extra.slice(0, 2).join(' · ')
    const more =
      orphan.threadCount > orphan.sampleTitles.length
        ? ` · +${String(orphan.threadCount - orphan.sampleTitles.length)} more`
        : ''
    return `${countLabel} · ${shown}${more}`
  }

  function orphanRecoverDetail(orphan: OrphanProjectStore): string {
    const lines: string[] = [
      'Choose the folder this conversation belonged to. Copse will attach the saved threads to that project.',
    ]
    if (orphan.sampleTitles.length > 0) {
      lines.push('')
      lines.push('Threads in this store:')
      for (const title of orphan.sampleTitles) {
        lines.push(`• ${title}`)
      }
      if (orphan.threadCount > orphan.sampleTitles.length) {
        lines.push(`• …and ${String(orphan.threadCount - orphan.sampleTitles.length)} more`)
      }
    } else {
      lines.push('')
      lines.push(
        `This store holds ${String(orphan.threadCount)} thread${orphan.threadCount === 1 ? '' : 's'}.`,
      )
    }
    lines.push('')
    lines.push(`Store id: ${orphan.id}`)
    return lines.join('\n')
  }

  function renderOrphansSection(): HTMLElement {
    const section = el('div', { class: 'orphans-section' })
    section.append(
      el(
        'div',
        { class: 'orphans-heading' },
        warningIcon('ui-icon ui-icon-sm'),
        el('span', {}, 'Recoverable threads'),
      ),
      el(
        'p',
        { class: 'orphans-hint' },
        'Saved chats with no project in the sidebar. Recover attaches them to a folder; Dismiss hides the row (threads stay on disk).',
      ),
    )
    for (const orphan of orphans) {
      const primary = orphanPrimaryLabel(orphan)
      const subtitle = orphanSubtitle(orphan)
      const row = el(
        'div',
        {
          class: 'orphan-row',
          title: `Store ${orphan.id}`,
          'data-orphan-id': orphan.id,
        },
        el(
          'div',
          { class: 'orphan-copy' },
          el('span', { class: 'orphan-name' }, primary),
          el('span', { class: 'orphan-meta' }, subtitle),
        ),
      )
      const actions = el('div', { class: 'orphan-actions' })
      const dismissBtn = el(
        'button',
        { type: 'button', class: 'orphan-dismiss-btn', title: 'Hide this store from the list' },
        'Dismiss',
      )
      dismissBtn.addEventListener('click', () => {
        void dismissOrphanProject(api, orphan.id)
          .then(() => {
            orphans = orphans.filter((entry) => entry.id !== orphan.id)
            render(true)
            showToast('Recoverable threads hidden. They remain on disk.')
          })
          .catch((err: unknown) => {
            showErrorToast('Could not dismiss recoverable threads', err)
          })
      })
      const recoverBtn = el('button', { type: 'button', class: 'orphan-recover-btn' }, 'Recover…')
      recoverBtn.addEventListener('click', () => {
        void recoverOrphanProject(store, api, orphan.id, () =>
          showConfirmDialog({
            message: `Recover “${primary}”?`,
            detail: orphanRecoverDetail(orphan),
            confirmLabel: 'Choose folder…',
            cancelLabel: 'Cancel',
          }),
        )
          .then((recovered) => {
            if (!recovered) return
            orphans = orphans.filter((entry) => entry.id !== orphan.id)
            render()
          })
          .catch((err: unknown) => {
            showErrorToast('Could not recover threads', err)
          })
      })
      actions.append(dismissBtn, recoverBtn)
      row.append(actions)
      section.append(row)
    }
    return section
  }

  function refreshOrphansIfProjectSetChanged(): void {
    const nextIds = new Set(store.getState().projects.map((project) => project.id))
    if (
      nextIds.size === knownProjectIds.size &&
      [...nextIds].every((id) => knownProjectIds.has(id))
    ) {
      return
    }
    knownProjectIds = nextIds
    refreshOrphans()
  }

  function refreshOrphans(): void {
    const generation = ++orphanScanGeneration
    void listOrphanProjects(api)
      .then((scanned) => {
        if (generation !== orphanScanGeneration) return
        // Recovery can emit before its new project id reaches main-process
        // config. Exclude ids already known to the renderer from that stale scan.
        const known = new Set(store.getState().projects.map((project) => project.id))
        const next = scanned.filter((orphan) => !known.has(orphan.id))
        const changed =
          next.length !== orphans.length ||
          next.some((o, i) => {
            const prev = orphans[i]
            return (
              !prev ||
              o.id !== prev.id ||
              o.threadCount !== prev.threadCount ||
              o.updatedAt !== prev.updatedAt ||
              o.sampleTitles.join('\0') !== prev.sampleTitles.join('\0')
            )
          })
        orphans = next
        if (changed) render()
      })
      .catch((err: unknown) => {
        if (generation !== orphanScanGeneration) return
        showErrorToast('Could not scan recoverable threads', err)
      })
  }

  const DROP_CLASSES = ['drop-before', 'drop-after', 'drop-into'] as const

  /** Drop feedback is one line at a time, so clear the whole list before painting. */
  function clearDropIndicators(): void {
    for (const marked of list.querySelectorAll('.drop-before, .drop-after, .drop-into')) {
      marked.classList.remove(...DROP_CLASSES)
    }
  }

  function endDrag(): void {
    activeDrag = null
    clearDropIndicators()
    for (const dragging of list.querySelectorAll('.is-dragging')) {
      dragging.classList.remove('is-dragging')
    }
  }

  /** Make `row` the drag handle for `node`, marking `block` as the thing in flight. */
  function bindDragSource(row: HTMLElement, node: SidebarNodeRef, block: HTMLElement): void {
    row.draggable = true
    row.addEventListener('dragstart', (e) => {
      const payload: SidebarDragPayload = { kind: node.kind, id: node.id }
      // No `text/plain` alongside it: that would spill an opaque id into every
      // text drop target in the app (the composer, the URL bar) for a drag that
      // only the sidebar can act on.
      e.dataTransfer?.setData(SIDEBAR_DRAG_MIME, serializeSidebarDrag(payload))
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
      activeDrag = payload
      block.classList.add('is-dragging')
    })
    row.addEventListener('dragend', endDrag)
  }

  /**
   * Which drop a hovered row would accept, or `null` when it would accept none —
   * dropping a row onto itself, or a group into its own subtree. Returning null
   * (and so never calling `preventDefault`) is what makes the pointer show
   * "no drop" rather than promising a move that would be a no-op.
   */
  function resolveDropIntent(
    drag: SidebarDragPayload,
    target: SidebarNodeRef & { groupId?: string | null },
    clientY: number,
    bounds: { top: number; height: number },
  ): DropIntent | null {
    if (drag.kind === target.kind && drag.id === target.id) return null
    // Groups do not nest, so only a project can be dropped *into* a group.
    const allowInto = target.kind === 'group' && drag.kind === 'project'
    if (drag.kind === 'group' && target.kind === 'project' && target.groupId === drag.id) {
      return null
    }
    return dropIntent(clientY, bounds, { allowInto })
  }

  /**
   * Wire one sidebar row as a drop target. `row` takes the pointer events (a
   * tight, predictable hit area) while `block` carries the indicator, so an
   * expanded project shows the insertion line against its whole block of threads
   * rather than a line floating between a project and its own chats.
   */
  function bindDropTarget(
    row: HTMLElement,
    block: HTMLElement,
    target: SidebarNodeRef & { groupId?: string | null },
  ): void {
    const intentAt = (e: DragEvent): DropIntent | null => {
      if (!isSidebarDrag(e.dataTransfer?.types)) return null
      const drag = activeDrag
      if (!drag) return null
      return resolveDropIntent(drag, target, e.clientY, row.getBoundingClientRect())
    }

    row.addEventListener('dragover', (e) => {
      const intent = intentAt(e)
      if (!intent) return
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      clearDropIndicators()
      block.classList.add(`drop-${intent}`)
    })
    row.addEventListener('dragleave', () => {
      block.classList.remove(...DROP_CLASSES)
    })
    row.addEventListener('drop', (e) => {
      const intent = intentAt(e)
      // Swallow the drop either way: a rejected sidebar drag must not fall
      // through to the list's own "move to top level" handler behind this row.
      e.preventDefault()
      e.stopPropagation()
      // Prefer the payload the drop actually carries; `activeDrag` is the
      // fallback for the (test-only) case of a synthetic event without data.
      const raw = e.dataTransfer?.getData(SIDEBAR_DRAG_MIME) ?? ''
      const payload = parseSidebarDrag(raw) ?? activeDrag
      endDrag()
      if (!intent || !payload) return
      if (intent === 'into') {
        // `resolveDropIntent` only offers "into" for a project over a group, so
        // this pairing is the only one that can reach here.
        if (target.kind === 'group' && payload.kind === 'project') {
          moveProjectIntoGroup(store, api, payload.id, target.id)
        }
        return
      }
      reorderSidebarNode(store, api, payload, target.id, intent)
    })
  }

  // Empty space below the rows is the way back out of a group: a project dropped
  // there leaves whatever group it was in and lands at the end of the sidebar.
  list.addEventListener('dragover', (e) => {
    if (!isSidebarDrag(e.dataTransfer?.types)) return
    if (activeDrag?.kind !== 'project') return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    clearDropIndicators()
    list.classList.add('drop-into')
  })
  list.addEventListener('dragleave', () => {
    list.classList.remove(...DROP_CLASSES)
  })
  list.addEventListener('drop', (e) => {
    if (!isSidebarDrag(e.dataTransfer?.types)) return
    e.preventDefault()
    const payload = parseSidebarDrag(e.dataTransfer?.getData(SIDEBAR_DRAG_MIME) ?? '') ?? activeDrag
    list.classList.remove(...DROP_CLASSES)
    endDrag()
    if (payload?.kind !== 'project') return
    moveProjectIntoGroup(store, api, payload.id, null)
  })

  function beginGroupRename(groupId: string, currentName: string): void {
    renamingGroup = { groupId, draft: currentName }
    render()
    const input = list.querySelector<HTMLInputElement>(
      `.project-group[data-group-id="${CSS.escape(groupId)}"] .project-group-rename`,
    )
    input?.focus()
    input?.select()
  }

  function finishGroupRename(save: boolean): void {
    if (!renamingGroup) return
    const { groupId, draft } = renamingGroup
    renamingGroup = null
    if (save) renameProjectGroup(store, api, groupId, draft)
    render()
  }

  /** The header row for a group: twisty, name (or rename input), member count. */
  function renderGroupRow(group: ProjectGroup, memberCount: number): HTMLElement {
    const collapsed = group.collapsed === true
    const renameState = renamingGroup?.groupId === group.id ? renamingGroup : null
    let label: HTMLElement
    if (renameState) {
      const input = el('input', {
        type: 'text',
        class: 'project-group-rename',
        'aria-label': 'Rename group',
      })
      input.value = renameState.draft
      input.addEventListener('input', () => {
        if (renamingGroup?.groupId === group.id) renamingGroup.draft = input.value
      })
      input.addEventListener('keydown', (e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          finishGroupRename(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finishGroupRename(false)
        }
      })
      bindRenameBlur(input, () => {
        if (renamingGroup?.groupId !== group.id) return
        finishGroupRename(true)
      })
      for (const evt of ['click', 'dblclick', 'mousedown'] as const) {
        input.addEventListener(evt, (e) => {
          e.stopPropagation()
        })
      }
      label = input
    } else {
      label = el('span', { class: 'project-group-name' }, group.name)
    }

    const row = el(
      'button',
      {
        type: 'button',
        class: 'project-group-row',
        'aria-expanded': collapsed ? 'false' : 'true',
        title: group.name,
      },
      el(
        'span',
        { class: `project-twisty${collapsed ? '' : ' expanded'}` },
        chevronRightIcon('ui-icon ui-icon-sm'),
      ),
      label,
      el('span', { class: 'project-group-count' }, String(memberCount)),
    )
    row.addEventListener('click', () => {
      if (renamingGroup?.groupId === group.id) return
      setProjectGroupCollapsed(store, api, group.id, !collapsed)
    })
    if (!renameState) {
      label.addEventListener('dblclick', (e) => {
        e.stopPropagation()
        beginGroupRename(group.id, group.name)
      })
    }
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      showContextMenu(e.clientX, e.clientY, [
        {
          label: 'Rename group',
          onSelect: (): void => {
            beginGroupRename(group.id, group.name)
          },
        },
        {
          // Deleting a group never deletes projects — they return to the top
          // level — so the label says what actually happens.
          label: 'Ungroup projects',
          onSelect: (): void => {
            deleteProjectGroup(store, api, group.id)
          },
        },
      ])
    })
    return row
  }

  /** Menu entries for moving one project between groups without a drag. */
  function groupMenuEntries(project: Project, groups: readonly ProjectGroup[]): ContextMenuEntry[] {
    const currentGroupId = projectGroupId(project, groups)
    const entries: ContextMenuEntry[] = [{ heading: 'Group' }]
    entries.push({
      label: 'New group…',
      onSelect: (): void => {
        const groupId = createProjectGroup(store, api, { withProjectId: project.id })
        const created = store.getState().projectGroups.find((g) => g.id === groupId)
        // Land straight in the rename box: a group called "Group" is only useful
        // once it is called something else.
        if (created) beginGroupRename(groupId, created.name)
      },
    })
    for (const group of groups) {
      entries.push({
        label: group.name,
        checked: group.id === currentGroupId,
        onSelect: (): void => {
          moveProjectIntoGroup(store, api, project.id, group.id)
        },
      })
    }
    if (currentGroupId !== null) {
      entries.push({
        label: 'Remove from group',
        onSelect: (): void => {
          moveProjectIntoGroup(store, api, project.id, null)
        },
      })
    }
    return entries
  }

  function render(preserveScroll = false): void {
    // Rebuilding the list removes its children synchronously. In Chromium that
    // clamps the scroll container to the top while the content is empty, so the
    // dismiss action opts into keeping the reader's position.
    const scrollTop = preserveScroll ? list.scrollTop : 0
    prBackfillObserver?.disconnect()
    prBackfillObserver = null
    clear(list)
    const prBackfillRows: Array<{ row: HTMLElement; projectId: string; threadId: string }> = []
    const threadChangeWanted: Array<{ projectId: string; threadId: string }> = []
    const threadChangeSeen: Array<{ projectId: string; threadId: string }> = []
    const threadChangeSeenKeys = new Set<string>()
    syncFilterControls()
    const { projects, projectGroups, activeProjectId, expandedProjectId, activeThreadId } =
      store.getState()
    // The project filter narrows what is listed, not what exists: automations,
    // orphans and every other store read still see all of them.
    const visibleProjects =
      projectFilterId === null
        ? projects
        : projects.filter((project) => project.id === projectFilterId)
    const expandedId = expandedProjectId ?? activeProjectId

    if (projects.length === 0 && projectGroups.length === 0 && orphans.length === 0) {
      list.append(el('div', { class: 'sidebar-empty' }, 'No projects yet. Click "+".'))
      if (preserveScroll) list.scrollTop = scrollTop
      return
    }

    /**
     * One sidebar thread row, owned by `project` (not necessarily the active
     * one — the workspace-level Automations section below renders rows for
     * background projects too). `activeId` mirrors the pre-#2511 per-project
     * local: null unless `project` is the active project, so a background
     * project's own rows never read as "unread while selected".
     */
    function renderThreadRow(
      project: Project,
      thread: SidebarThread,
      options: { displayTitle?: string; allowRename?: boolean } = {},
    ): HTMLElement {
      const activeId = project.id === activeProjectId ? activeThreadId : null
      const displayTitle = (options.displayTitle ?? thread.title) || 'New Thread'
      const canMutate = project.id === activeProjectId
      const allowRename = (options.allowRename ?? true) && canMutate
      const scheduleId = thread.automation?.scheduleId
      const renameState =
        allowRename && renaming !== null && renaming.threadId === thread.id ? renaming : null
      let title: HTMLElement
      if (renameState) {
        const input = el('input', {
          type: 'text',
          class: 'chat-title-rename',
          'aria-label': 'Rename thread',
        })
        input.value = renameState.draft
        input.addEventListener('input', () => {
          if (renaming?.threadId === thread.id) renaming.draft = input.value
        })
        input.addEventListener('keydown', (e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            finishThreadRename(true)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            finishThreadRename(false)
          }
        })
        bindRenameBlur(input, () => {
          if (renaming?.threadId !== thread.id) return
          finishThreadRename(true)
        })
        for (const evt of ['click', 'dblclick', 'mousedown'] as const) {
          input.addEventListener(evt, (e) => {
            e.stopPropagation()
          })
        }
        title = input
      } else {
        title = el('span', { class: 'chat-title' }, displayTitle)
        if (allowRename) {
          title.addEventListener('dblclick', (e) => {
            e.stopPropagation()
            beginThreadRename(thread.id, displayTitle)
          })
        }
      }
      const chatRow = el(
        'div',
        {
          class: `chat-row${thread.automation ? ' is-automation' : ''}${thread.id === activeThreadId && project.id === activeProjectId ? ' selected' : ''}`,
          'data-thread-id': thread.id,
        },
        title,
      )
      chatRow.addEventListener('click', () => {
        if (renaming?.threadId === thread.id) return
        switchProjectThread(store, api, project.id, thread.id)
      })
      const openThreadMenu = (x: number, y: number): void => {
        showContextMenu(x, y, [
          ...(canMutate
            ? [
                ...(allowRename
                  ? [
                      {
                        label: 'Rename',
                        onSelect: (): void => {
                          beginThreadRename(thread.id, displayTitle)
                        },
                      },
                    ]
                  : []),
                {
                  label: 'Fork',
                  onSelect: (): void => {
                    showContextMenu(x, y, [
                      { heading: 'Fork' },
                      {
                        label: 'Fork a copy',
                        onSelect: (): void => {
                          forkProjectThread(project.id, thread.id)
                        },
                      },
                      {
                        label: 'Edit thread history…',
                        onSelect: (): void => {
                          openThreadHistoryEditor(store, api, {
                            projectId: project.id,
                            threadId: thread.id,
                          })
                        },
                      },
                    ])
                  },
                },
                {
                  label: 'Archive',
                  onSelect: (): void => {
                    void archiveProjectThread(project.id, thread.id)
                  },
                },
              ]
            : []),
          // A schedule with a single run has no heading of its own, and a
          // historical run is several rows below the one that does, so every
          // automation row carries the way out to its setup. Opens directly
          // against this run's own project — same as the project menu's
          // "Automations" entry — rather than switching the active project
          // just to reach the editor.
          ...(scheduleId
            ? [
                {
                  label: 'Run now',
                  onSelect: (): void => {
                    startRunNow(api, {
                      project,
                      scheduleName: thread.automation?.scheduleName ?? thread.title,
                      scheduleId,
                    })
                  },
                },
                {
                  label: 'Automation setup…',
                  onSelect: (): void => {
                    openAutomationDialog(store, api, { projectId: project.id, scheduleId })
                  },
                },
              ]
            : []),
          ...(canMutate
            ? [
                {
                  label: 'Delete',
                  disabled: getSidebarThreads(store, project.id).length <= 1,
                  onSelect: (): void => {
                    if (
                      store.getState().activeProjectId !== project.id ||
                      getSidebarThreads(store, project.id).length <= 1
                    ) {
                      return
                    }
                    void api.agent.clearHistory(project.id, thread.id)
                    deleteThread(store, thread.id)
                  },
                },
              ]
            : []),
        ])
      }
      chatRow.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        e.stopPropagation()
        openThreadMenu(e.clientX, e.clientY)
      })

      if (thread.status === 'running') {
        chatRow.classList.add('is-running')
        chatRow.insertBefore(runningStatus('Agent is working'), title)
      } else if (
        (thread.unreadAt !== undefined ||
          getSideChatUnreadParents(store, project.id).has(thread.id)) &&
        thread.id !== activeId
      ) {
        chatRow.classList.add('is-unread')
        chatRow.insertBefore(
          el('span', {
            class: 'chat-unread-dot',
            role: 'img',
            'aria-label':
              thread.unreadAt !== undefined
                ? 'Unread agent completion'
                : 'Unread reply in a side chat',
          }),
          title,
        )
      }

      if (isThreadAwaitingAttention(thread.id)) {
        chatRow.classList.add('needs-attention')
        chatRow.append(attentionBell('This thread needs your attention'))
      }

      const prRollup = rollupForThread(thread)
      if (prRollup) {
        chatRow.classList.add('has-pr-status')
        chatRow.append(
          chatPrStatus(
            prRollup,
            prRollup.kind === 'open' && ciFailingForThread(thread),
            prRollup.kind === 'open' && conflictsForThread(thread),
          ),
        )
      } else if (thread.status !== 'running' && thread.prRefs !== undefined && !project.sshHost) {
        const key = threadChangeKey(project.id, thread.id)
        threadChangeSeen.push({ projectId: project.id, threadId: thread.id })
        threadChangeSeenKeys.add(key)
        const cached = threadChangeCache.get(key)
        const changesLabel = describeThreadChanges(cached?.summary ?? null)
        if (changesLabel) {
          chatRow.classList.add('has-changes-status')
          chatRow.append(chatChangesStatus(changesLabel))
        }
        if (!cached || Date.now() - cached.at > THREAD_CHANGE_TTL_MS) {
          threadChangeWanted.push({ projectId: project.id, threadId: thread.id })
        }
      }

      if (thread.prRefs === undefined) {
        prBackfillRows.push({ row: chatRow, projectId: project.id, threadId: thread.id })
      }

      if (canMutate) {
        const menuButton = el(
          'button',
          {
            type: 'button',
            class: 'chat-menu-btn',
            'aria-label': `Thread menu for ${displayTitle}`,
            'aria-haspopup': 'menu',
            'data-tooltip': 'Thread menu',
          },
          moreVerticalIcon('ui-icon ui-icon-sm'),
        )
        menuButton.addEventListener('click', (e) => {
          e.stopPropagation()
          const rect = menuButton.getBoundingClientRect()
          openThreadMenu(rect.left, rect.bottom)
        })
        chatRow.append(menuButton)
      }
      return chatRow
    }

    /**
     * The workspace-level Automations section (#2511): every automation run
     * across every project visited this session, collated directly under the
     * workspace rather than tucked inside each project's own thread list.
     * Grouped by schedule exactly as the old per-project heading grouped its
     * own runs — a schedule with one run is a single row, more than one gets
     * its own collapsible sub-heading — with the owning project named as a
     * muted suffix so same-named schedules in different projects stay
     * distinguishable.
     *
     * Automation data is strictly project-owned (`AutomationSchedule.projectId`,
     * `SidebarThread.automation`); there is no workspace-level store to read
     * instead. `getSidebarThreads` has data for the active project plus every
     * project switched to or read in the background after startup (see
     * `preloadSidebarThreads` in controller/projects.ts), so a project whose
     * background read has not finished yet contributes nothing until it does.
     */
    function renderAutomationsSection(): HTMLElement | null {
      const scheduleOwners = new Map<
        string,
        { project: Project; scheduleId: string; runs: SidebarThread[] }
      >()
      for (const project of projects) {
        for (const thread of getSidebarThreads(store, project.id)) {
          const scheduleId = thread.automation?.scheduleId
          if (!scheduleId) continue
          const scheduleKey = `${project.id}\0${scheduleId}`
          const owner = scheduleOwners.get(scheduleKey)
          if (owner) owner.runs.push(thread)
          else scheduleOwners.set(scheduleKey, { project, scheduleId, runs: [thread] })
        }
      }
      if (scheduleOwners.size === 0) return null

      const allRuns = Array.from(scheduleOwners.values()).flatMap((owner) => owner.runs)
      const hasActiveAutomation = allRuns.some((thread) => thread.id === activeThreadId)
      const attentionRuns = allRuns.filter((thread) => isThreadAwaitingAttention(thread.id))
      const sectionExpanded =
        automationsSectionExpanded || hasActiveAutomation || attentionRuns.length > 0

      const section = el('div', { class: 'automation-threads-group' })
      const toggle = el(
        'button',
        {
          type: 'button',
          class: 'automation-threads-toggle',
          'aria-expanded': sectionExpanded ? 'true' : 'false',
        },
        el(
          'span',
          { class: `automation-threads-twisty${sectionExpanded ? ' expanded' : ''}` },
          chevronRightIcon('ui-icon ui-icon-sm'),
        ),
        el('span', { class: 'automation-threads-title' }, 'Automations'),
        el('span', { class: 'automation-threads-count' }, String(scheduleOwners.size)),
      )
      if (allRuns.some((thread) => thread.status === 'running')) {
        const status = runningStatusIcon('ui-icon ui-icon-sm automation-threads-running')
        status.setAttribute('role', 'img')
        status.setAttribute('aria-label', 'An automation is running')
        status.removeAttribute('aria-hidden')
        toggle.append(status)
      }
      toggle.addEventListener('click', () => {
        automationsSectionExpanded = !automationsSectionExpanded
        render()
      })
      toggle.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        e.stopPropagation()
        showContextMenu(e.clientX, e.clientY, [
          {
            label: 'New automation…',
            onSelect: (): void => {
              openAutomationDialog(store, api, { createNew: true })
            },
          },
        ])
      })
      section.append(
        el(
          'div',
          { class: 'automation-threads-header' },
          toggle,
          // Creates against the active project, same default the plugin editor
          // itself falls back to when no project is named — there is no single
          // project this workspace-level heading could otherwise imply.
          automationSetupBtn(
            'New automation…',
            () => {
              openAutomationDialog(store, api, { createNew: true })
            },
            plusIcon,
          ),
        ),
      )

      if (sectionExpanded) {
        const rows = el('div', { class: 'automation-thread-rows' })
        for (const { project, scheduleId, runs } of scheduleOwners.values()) {
          const firstRun = runs[0]
          if (!firstRun) continue
          const projectSuffix = el(
            'span',
            { class: 'chat-thread-owner' },
            `· ${projectDisplayName(project)}`,
          )
          if (runs.length === 1) {
            const row = renderThreadRow(project, firstRun)
            row.querySelector('.chat-title')?.after(projectSuffix)
            const scheduleName = firstRun.automation?.scheduleName ?? firstRun.title
            const setupBtn = automationSetupBtn(`${scheduleName} setup`, () => {
              openAutomationDialog(store, api, { projectId: project.id, scheduleId })
            })
            // A lone run has no schedule heading of its own to carry the setup
            // button, so the row carries it directly (kept quiet like the
            // menu button beside it — see the `.chat-row:hover` reveal rule).
            const menuButton = row.querySelector('.chat-menu-btn')
            if (menuButton) menuButton.before(setupBtn)
            else row.append(setupBtn)
            rows.append(row)
            continue
          }

          const scheduleKey = `${project.id}\0${scheduleId}`
          const hasActiveRun = runs.some((thread) => thread.id === activeThreadId)
          const showingAllRuns = expandedAutomationSchedules.has(scheduleKey) || hasActiveRun
          // Collapsed, a schedule keeps its live and failed runs in view and folds
          // the finished ones into its heading's run count (see `foldAutomationRuns`).
          const foldEntries = foldAutomationRuns(runs, isThreadAwaitingAttention)
          const scheduleRevealed = showingAllRuns || foldEntries.length > 0
          const scheduleName = firstRun.automation?.scheduleName ?? firstRun.title
          const scheduleGroup = el('div', {
            class: 'automation-schedule-group',
            'data-schedule-id': scheduleId,
          })
          const scheduleToggle = el(
            'button',
            {
              type: 'button',
              class: 'automation-schedule-toggle',
              'aria-expanded': showingAllRuns ? 'true' : 'false',
            },
            el(
              'span',
              { class: `automation-threads-twisty${showingAllRuns ? ' expanded' : ''}` },
              chevronRightIcon('ui-icon ui-icon-sm'),
            ),
            el('span', { class: 'automation-schedule-title' }, scheduleName),
            projectSuffix,
            el('span', { class: 'automation-schedule-count' }, `${String(runs.length)} runs`),
          )
          if (runs.some((thread) => thread.status === 'running')) {
            const status = runningStatusIcon('ui-icon ui-icon-sm automation-threads-running')
            status.setAttribute('role', 'img')
            status.setAttribute('aria-label', 'This automation is running')
            status.removeAttribute('aria-hidden')
            scheduleToggle.append(status)
          }
          scheduleToggle.addEventListener('click', () => {
            if (expandedAutomationSchedules.has(scheduleKey)) {
              expandedAutomationSchedules.delete(scheduleKey)
            } else {
              expandedAutomationSchedules.add(scheduleKey)
            }
            render()
          })
          scheduleGroup.append(
            el(
              'div',
              { class: 'automation-schedule-header' },
              scheduleToggle,
              automationSetupBtn(`${scheduleName} setup`, () => {
                openAutomationDialog(store, api, { projectId: project.id, scheduleId })
              }),
            ),
          )
          scheduleToggle.addEventListener('contextmenu', (e) => {
            e.preventDefault()
            e.stopPropagation()
            showContextMenu(
              e.clientX,
              e.clientY,
              automationMenuEntries(
                api,
                {
                  project,
                  scheduleName,
                  scheduleId,
                },
                () => {
                  openAutomationDialog(store, api, { projectId: project.id, scheduleId })
                },
              ),
            )
          })
          if (scheduleRevealed) {
            const runRows = el('div', { class: 'automation-schedule-runs' })
            const runRow = (thread: SidebarThread): HTMLElement => {
              const index = runs.indexOf(thread)
              const timestamp = thread.automation?.triggeredAt
              const when = timestamp
                ? new Date(timestamp).toLocaleString([], {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })
                : 'Unknown time'
              return renderThreadRow(project, thread, {
                displayTitle: index === 0 ? `Latest · ${when}` : when,
                allowRename: false,
              })
            }
            if (showingAllRuns) {
              for (const thread of runs) runRows.append(runRow(thread))
            } else {
              for (const entry of foldEntries) {
                if (entry.kind === 'run') {
                  runRows.append(runRow(entry.run))
                } else if (entry.kind === 'pending') {
                  // Too many to list: one row that hands off to the Activity list,
                  // where each can be approved or answered with its full request.
                  const row = el(
                    'button',
                    { type: 'button', class: 'automation-fold-row needs-attention' },
                    el(
                      'span',
                      { class: 'automation-fold-label' },
                      `${String(entry.runs.length)} need you`,
                    ),
                    el('span', { class: 'chat-thread-owner' }, 'Open in Activity'),
                  )
                  row.addEventListener('click', () => {
                    openActivityPanel()
                  })
                  runRows.append(row)
                } else {
                  const open = expandedFailedSchedules.has(scheduleKey)
                  const row = el(
                    'button',
                    {
                      type: 'button',
                      class: 'automation-fold-row is-failed',
                      'aria-expanded': open ? 'true' : 'false',
                    },
                    el(
                      'span',
                      { class: 'automation-fold-label' },
                      `${String(entry.runs.length)} failed`,
                    ),
                  )
                  row.addEventListener('click', () => {
                    if (open) expandedFailedSchedules.delete(scheduleKey)
                    else expandedFailedSchedules.add(scheduleKey)
                    render()
                  })
                  runRows.append(row)
                  if (open) for (const thread of entry.runs) runRows.append(runRow(thread))
                }
              }
            }
            scheduleGroup.append(runRows)
          }
          rows.append(scheduleGroup)
        }
        section.append(rows)
      }
      return section
    }

    /** The "+" beside a project: switch to it first, then start a thread there. */
    function renderNewThreadButton(project: Project): HTMLButtonElement {
      const newThreadBtn = el(
        'button',
        {
          type: 'button',
          class: 'project-new-thread-btn',
          'aria-label': 'New thread',
          'data-tooltip': 'New thread',
        },
        plusIcon('ui-icon ui-icon-sm'),
      )
      newThreadBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        if (project.id !== store.getState().activeProjectId) {
          switchProject(store, api, project.id)
          return
        }
        if (!store.getState().workspaceRoot) {
          void addProject(store, api)
          return
        }
        openNewThread(store)
      })
      return newThreadBtn
    }

    /**
     * One project's whole block — header row, quarantine notice, thread list —
     * as a single element. Wrapping it means a drop indicator can be drawn
     * against the block rather than squeezed between a project and its own
     * threads, and it gives a group somewhere to put its members.
     */
    function renderProjectEntry(project: Project): HTMLElement {
      const entry = el('div', { class: 'project-entry', 'data-project-id': project.id })
      const isExpanded = project.id === expandedId
      const projectRow = el(
        'button',
        {
          class: `project-row${isExpanded ? ' active' : ''}${project.missing ? ' missing' : ''}`,
          title: project.missing ? `${project.path} — folder missing` : project.path,
        },
        el(
          'span',
          { class: `project-twisty${isExpanded ? ' expanded' : ''}` },
          chevronRightIcon('ui-icon ui-icon-sm'),
        ),
        el('span', { class: 'project-name' }, projectDisplayName(project)),
      )
      const node: SidebarNodeRef & { groupId: string | null } = {
        kind: 'project',
        id: project.id,
        groupId: projectGroupId(project, projectGroups),
      }
      bindDragSource(projectRow, node, entry)
      bindDropTarget(projectRow, entry, node)
      // Flag a quarantined project whose folder could not be opened (#997); its
      // threads are preserved on disk and recoverable via the notice below.
      if (project.missing) {
        projectRow.append(warningIcon('ui-icon ui-icon-sm project-missing-icon'))
      } else if (
        // A collapsed project hides its thread rows, so surface any thread of its
        // own that is waiting on the user right on the project row (expanded
        // projects show the per-thread bells below instead).
        !isExpanded &&
        getSidebarThreads(store, project.id).some((t) => isThreadAwaitingAttention(t.id))
      ) {
        projectRow.append(attentionBell('A thread in this project needs your attention'))
      }
      projectRow.addEventListener('click', () => {
        // A missing project can't be activated (its folder is gone), so clicking
        // just expands it to reveal the relocate notice rather than re-failing.
        if (project.missing) {
          store.setState({ expandedProjectId: isExpanded ? null : project.id })
          store.emit('projects_changed')
          return
        }
        switchProject(store, api, project.id)
      })
      const projectMenuEntries: ContextMenuEntry[] = [
        {
          label: 'Remove from sidebar',
          onSelect: (): void => {
            void removeProject(store, api, project.id)
          },
        },
        ...groupMenuEntries(project, projectGroups),
      ]
      projectRow.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        e.stopPropagation()
        showContextMenu(e.clientX, e.clientY, projectMenuEntries)
      })
      const menuButton = el(
        'button',
        {
          type: 'button',
          class: 'project-menu-btn',
          'aria-label': `Project menu for ${projectDisplayName(project)}`,
          'aria-haspopup': 'menu',
          'data-tooltip': 'Project menu',
        },
        moreHorizontalIcon('ui-icon ui-icon-sm'),
      )
      menuButton.addEventListener('click', () => {
        menuButton.disabled = true
        const state = store.getState()
        void Promise.all([
          api.plugins.list(),
          api.appRun
            .detect({
              projectId: project.id,
              ...(state.activeProjectId === project.id && state.activeThreadId
                ? { threadId: state.activeThreadId }
                : {}),
            })
            .catch(() => false),
        ])
          .then(([result, appDetected]) => {
            if (!menuButton.isConnected) return
            const rect = menuButton.getBoundingClientRect()
            const entries: ContextMenuEntry[] = []
            if (appDetected) {
              entries.push({
                label: 'Run app…',
                onSelect: (): void => {
                  if (store.getState().activeProjectId === project.id) {
                    openAppRunDialog(store, api, project.id)
                    return
                  }
                  const unsubscribe = store.on('workspace_changed', () => {
                    if (store.getState().activeProjectId === project.id) {
                      unsubscribe()
                      openAppRunDialog(store, api, project.id)
                    } else if (!isProjectSwitchInFlight(store, project.id)) {
                      unsubscribe()
                    }
                  })
                  switchProject(store, api, project.id)
                },
              })
            }
            if (result.plugins.some(hasAutomationDialog)) {
              entries.push(
                {
                  label: 'Automations',
                  onSelect: (): void => {
                    openAutomationDialog(store, api, { projectId: project.id })
                  },
                },
                {
                  label: 'New automation…',
                  disabled: project.missing === true,
                  onSelect: (): void => {
                    openAutomationDialog(store, api, { projectId: project.id, createNew: true })
                  },
                },
              )
            }
            showContextMenu(rect.left, rect.bottom, [...entries, ...projectMenuEntries])
          })
          .catch((error: unknown) => {
            showErrorToast('Could not load project menu', error)
          })
          .finally(() => {
            menuButton.disabled = false
          })
      })
      const projectLine = el('div', { class: 'project-line' }, projectRow, menuButton)
      entry.append(projectLine)

      if (isExpanded && project.missing) {
        entry.append(renderMissingNotice(project))
        return entry
      }

      if (isExpanded) {
        projectLine.append(renderNewThreadButton(project))
      }

      if (!isExpanded) return entry

      const isFiltering = threadFilter.length > 0 && project.id === activeProjectId
      const sidebarThreads = isFiltering
        ? withoutSideChats(sortThreadsNewestFirst(store.getState().threads)).filter(
            (thread) => thread.archivedAt == null,
          )
        : getSidebarThreads(store, project.id)
      // Title matches appear immediately; user-request matches arrive in date
      // order. Search is scoped to the open workspace and bypasses pagination.
      const matchingThreads = isFiltering
        ? sidebarThreads.filter(
            (t) =>
              filterText(t.title || 'New Thread').includes(threadFilter) ||
              contentFilter.matches.has(t.id) ||
              residentRequestMatches(t.messages ?? [], threadFilter),
          )
        : sidebarThreads
      // Automation runs are collated in the workspace-level Automations section
      // (#2511) instead of rendering inside their project by default.
      const conversationThreads = orderSidebarThreads(
        matchingThreads.filter(
          (thread) =>
            thread.automation === undefined &&
            (!needsCleanupOnly || threadNeedsCleanup(project, thread)),
        ),
        // A filter's matches stay newest first; the chosen order is for the browse list.
        isFiltering ? 'activity' : store.getState().sidebarThreadSort,
        !isFiltering && store.getState().sidebarThreadSortReverse,
      )
      const visibleLimit = visibleThreadCounts.get(project.id) ?? SIDEBAR_THREADS_PAGE_SIZE
      const activeId = project.id === activeProjectId ? activeThreadId : null
      let visibleThreads: SidebarThread[]
      let visibleCount: number
      let hasMore: boolean
      if (isFiltering) {
        visibleThreads = conversationThreads
        visibleCount = conversationThreads.length
        hasMore = false
      } else {
        const activeConversationId = conversationThreads.some((thread) => thread.id === activeId)
          ? activeId
          : null
        const paged = paginateSidebarThreads(
          conversationThreads,
          visibleLimit,
          activeConversationId,
        )
        visibleThreads = paged.visibleThreads
        visibleCount = paged.visibleCount
        hasMore = paged.hasMore
        // Only remember a window that had to GROW to reveal the active thread.
        // `paginateSidebarThreads` also clamps the count down to the thread total,
        // and caching that shrunken value would stick: a project showing 1 thread
        // would pin the window at 1, so the next thread it gains (a new chat, a
        // fork) lands behind "Show more" instead of appearing in the sidebar.
        // The filtering branch above deliberately caches nothing, since a filtered
        // view shows every match and must not resize the saved window.
        if (paged.visibleCount > visibleLimit) {
          visibleThreadCounts.set(project.id, paged.visibleCount)
        }
      }

      const chats = el('div', { class: 'chats-list' })
      if (sidebarThreads.length === 0 && isProjectSwitchInFlight(store, project.id)) {
        chats.append(el('div', { class: 'sidebar-empty chats-loading' }, 'Loading…'))
      } else if (isFiltering && contentFilter.pending) {
        chats.append(
          el(
            'div',
            { class: 'sidebar-empty thread-filter-status', role: 'status' },
            'Searching user requests…',
          ),
        )
      } else if (isFiltering && contentFilter.failed) {
        chats.append(
          el(
            'div',
            { class: 'sidebar-empty thread-filter-status', role: 'status' },
            'Some threads could not be searched',
          ),
        )
      } else if (isFiltering && !contentFilter.waiting && matchingThreads.length === 0) {
        chats.append(el('div', { class: 'sidebar-empty' }, 'No matching threads'))
      } else if (isFiltering && !contentFilter.waiting && conversationThreads.length === 0) {
        chats.append(el('div', { class: 'sidebar-empty' }, 'No matching threads need cleanup'))
      } else if (!isFiltering && visibleThreads.length === 0) {
        chats.append(
          el(
            'div',
            { class: 'sidebar-empty' },
            needsCleanupOnly ? 'Nothing needs cleanup' : 'No threads yet',
          ),
        )
      }

      for (const thread of visibleThreads) {
        chats.append(renderThreadRow(project, thread))
      }

      if (hasMore) {
        const showMoreBtn = el('button', { type: 'button', class: 'chats-show-more' }, 'Show more')
        showMoreBtn.addEventListener('click', () => {
          visibleThreadCounts.set(project.id, visibleCount + SIDEBAR_THREADS_PAGE_SIZE)
          render()
        })
        chats.append(showMoreBtn)
      }

      entry.append(chats)
      return entry
    }

    /** A group header plus its member entries, folded away when collapsed. */
    function renderGroupEntry(group: ProjectGroup, members: readonly Project[]): HTMLElement {
      const block = el('div', { class: 'project-group', 'data-group-id': group.id })
      const row = renderGroupRow(group, members.length)
      const node: SidebarNodeRef = { kind: 'group', id: group.id }
      bindDragSource(row, node, block)
      bindDropTarget(row, block, node)
      block.append(row)
      if (group.collapsed === true) return block
      const children = el('div', { class: 'project-group-children' })
      for (const member of members) children.append(renderProjectEntry(member))
      if (members.length === 0) {
        children.append(el('div', { class: 'sidebar-empty' }, 'Drag a project here'))
      }
      block.append(children)
      return block
    }

    // Directly under the workspace, above every project — see
    // `renderAutomationsSection` for why this collates across projects rather
    // than living inside each one (#2511).
    const automationsSection = renderAutomationsSection()
    if (automationsSection) list.append(automationsSection)

    /**
     * Threads from every project with loaded data, laid out without the project tree:
     * sections by status, or one flat list. Each row names its project, since
     * the tree that used to say so is gone. A search filter is scoped to the
     * open project, so it keeps the tree.
     */
    function renderThreadSections(mode: Exclude<ThreadGroupMode, 'project'>): HTMLElement[] {
      const owners = new Map<string, Project>()
      const rows: SidebarRow[] = []
      for (const project of visibleProjects) {
        if (project.missing) continue
        owners.set(project.id, project)
        for (const thread of getSidebarThreads(store, project.id)) {
          if (
            thread.automation === undefined &&
            (!needsCleanupOnly || threadNeedsCleanup(project, thread))
          ) {
            rows.push({ projectId: project.id, thread })
          }
        }
      }
      const { sidebarThreadSort, sidebarThreadSortReverse } = store.getState()
      const ordered = orderSidebarRows(rows, sidebarThreadSort, sidebarThreadSortReverse)
      const sections =
        mode === 'status'
          ? groupRowsByStatus(ordered, isThreadAwaitingAttention)
          : [{ id: 'all', label: '', rows: ordered }]
      // The tree is gone in this layout, so a project with no threads would vanish
      // with it, taking its name and its "+" along. Keep one compact row for each,
      // whether or not other projects have threads. Skipped under the cleanup
      // filter: there every project with nothing unlanded is meant to drop out,
      // not reappear as an empty placeholder.
      const withThreads = new Set(ordered.map((row) => row.projectId))
      const emptyProjectRows = needsCleanupOnly
        ? []
        : Array.from(owners.values())
            .filter((project) => !withThreads.has(project.id))
            .map((project) => {
              const nameRow = el(
                'button',
                { class: 'project-row', title: project.path },
                el('span', { class: 'project-name' }, projectDisplayName(project)),
              )
              nameRow.addEventListener('click', () => {
                switchProject(store, api, project.id)
              })
              return el(
                'div',
                { class: 'project-entry', 'data-project-id': project.id },
                el('div', { class: 'project-line' }, nameRow, renderNewThreadButton(project)),
              )
            })
      if (ordered.length === 0) {
        return [
          el(
            'div',
            { class: 'sidebar-empty' },
            needsCleanupOnly ? 'Nothing needs cleanup' : 'No threads yet',
          ),
          ...emptyProjectRows,
        ]
      }
      return sections
        .map((section) => {
          const block = el('div', { class: 'thread-section', 'data-section-id': section.id })
          if (section.label) {
            block.append(el('div', { class: 'thread-section-heading' }, section.label))
          }
          const byThread = new Map(section.rows.map((row) => [row.thread, row]))
          const countKey = `section:${mode}:${section.id}`
          const limit = visibleThreadCounts.get(countKey) ?? SIDEBAR_THREADS_PAGE_SIZE
          const activeRow = section.rows.find(
            (row) => row.projectId === activeProjectId && row.thread.id === activeThreadId,
          )
          const paged = paginateSidebarThreads(
            section.rows.map((row) => row.thread),
            limit,
            activeRow?.thread.id,
          )
          if (paged.visibleCount > limit) visibleThreadCounts.set(countKey, paged.visibleCount)
          const chats = el('div', { class: 'chats-list' })
          for (const thread of paged.visibleThreads) {
            const project = owners.get(byThread.get(thread)?.projectId ?? '')
            if (!project) continue
            const row = renderThreadRow(project, thread)
            row
              .querySelector('.chat-title')
              ?.after(
                el('span', { class: 'chat-thread-owner' }, `· ${projectDisplayName(project)}`),
              )
            chats.append(row)
          }
          if (paged.hasMore) {
            const showMoreBtn = el(
              'button',
              { type: 'button', class: 'chats-show-more' },
              'Show more',
            )
            showMoreBtn.addEventListener('click', () => {
              visibleThreadCounts.set(countKey, paged.visibleCount + SIDEBAR_THREADS_PAGE_SIZE)
              render()
            })
            chats.append(showMoreBtn)
          }
          block.append(chats)
          return block
        })
        .concat(emptyProjectRows)
    }

    const groupMode = store.getState().sidebarThreadGroup
    if (groupMode !== 'project' && threadFilter.length === 0) {
      list.append(...renderThreadSections(groupMode))
    } else {
      for (const node of buildProjectTree(visibleProjects, projectGroups)) {
        // A group with nothing of the chosen project in it has nothing to show.
        if (node.kind === 'group' && projectFilterId !== null && node.projects.length === 0)
          continue
        if (node.kind === 'group') list.append(renderGroupEntry(node.group, node.projects))
        else list.append(renderProjectEntry(node.project))
      }
    }

    if (orphans.length > 0) list.append(renderOrphansSection())

    prBackfillRowsByKey = new Map(
      prBackfillRows.map(({ row, projectId, threadId }) => [`${projectId}\0${threadId}`, row]),
    )
    if (prBackfillRows.length > 0 && typeof IntersectionObserver !== 'undefined') {
      const rowThreads = new Map<Element, { projectId: string; threadId: string }>(
        prBackfillRows.map(({ row, projectId, threadId }) => [row, { projectId, threadId }]),
      )
      const observer = new IntersectionObserver((entries) => {
        if (prBackfillObserver !== observer) return
        const pending = new Map<string, Array<{ threadId: string; row: Element }>>()
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          observer.unobserve(entry.target)
          const thread = rowThreads.get(entry.target)
          if (!thread) continue
          const requested = prBackfillRequested.get(thread.projectId) ?? new Set<string>()
          prBackfillRequested.set(thread.projectId, requested)
          if (requested.has(thread.threadId)) continue
          requested.add(thread.threadId)
          const rows = pending.get(thread.projectId) ?? []
          rows.push({ threadId: thread.threadId, row: entry.target })
          pending.set(thread.projectId, rows)
        }
        for (const [projectId, rows] of pending) {
          const requested = prBackfillRequested.get(projectId)
          for (let i = 0; i < rows.length; i += 10) {
            const batch = rows.slice(i, i + 10)
            const threadIds = batch.map(({ threadId }) => threadId)
            void api.threads
              .backfillPrRefs(projectId, threadIds)
              .then(() => {
                for (const threadId of threadIds) {
                  prBackfillRetryAttempts.delete(`${projectId}\0${threadId}`)
                }
              })
              .catch((err: unknown) => {
                let attempt = 1
                for (const threadId of threadIds) {
                  const key = `${projectId}\0${threadId}`
                  const nextAttempt = (prBackfillRetryAttempts.get(key) ?? 0) + 1
                  prBackfillRetryAttempts.set(key, nextAttempt)
                  attempt = Math.max(attempt, nextAttempt)
                }
                const delay = Math.min(1_000 * 2 ** (attempt - 1), 30_000)
                const timer = setTimeout(() => {
                  prBackfillRetryTimers.delete(timer)
                  for (const { threadId } of batch) requested?.delete(threadId)
                  const currentObserver = prBackfillObserver
                  if (!currentObserver) return
                  for (const { threadId } of batch) {
                    const row = prBackfillRowsByKey.get(`${projectId}\0${threadId}`)
                    if (row?.isConnected) currentObserver.observe(row)
                  }
                }, delay)
                prBackfillRetryTimers.add(timer)
                console.warn('[threads] visible PR-ref backfill failed:', err)
              })
          }
        }
      })
      prBackfillObserver = observer
      for (const { row } of prBackfillRows) observer.observe(row)
    }
    threadChangeRendered = threadChangeSeen
    const pruneBefore = Date.now() - 2 * THREAD_CHANGE_TTL_MS
    for (const [key, entry] of threadChangeCache) {
      if (entry.at < pruneBefore && !threadChangeSeenKeys.has(key)) threadChangeCache.delete(key)
    }
    refreshThreadChanges(threadChangeWanted)
    if (preserveScroll) list.scrollTop = scrollTop
  }

  const unsubWorkingTree = api.git.onWorkingTreeChanged(() => {
    if (threadChangeTimer !== null) clearTimeout(threadChangeTimer)
    threadChangeTimer = setTimeout(() => {
      threadChangeTimer = null
      const { activeProjectId, activeThreadId, projects } = store.getState()
      if (!activeProjectId || !activeThreadId) return
      if (projects.find((p) => p.id === activeProjectId)?.sshHost) return
      refreshThreadChanges([{ projectId: activeProjectId, threadId: activeThreadId }], {
        fresh: true,
      })
    }, 1_500)
  })

  window.addEventListener('focus', recheckStaleThreadChanges)
  document.addEventListener('visibilitychange', recheckStaleThreadChanges)

  const unsubs = [
    unsubWorkingTree,
    store.on('projects_changed', render),
    // Streaming and hydration must not restart the disk scan. Resident human
    // requests are matched in render(), so new prompts still appear immediately.
    store.on('threads_changed', render),
    store.on('sidebar_threads_loaded', render),
    // Status flips on its own event (not threads_changed) so the sidebar can
    // show/hide the running-dots mark without a full thread list rewrite.
    store.on('thread_status_changed', () => {
      render()
    }),
    store.on('workspace_changed', () => {
      // Only a switch to another workspace invalidates the filter; adding or
      // removing some other project leaves the open one's search intact.
      if (store.getState().activeProjectId !== filteredProjectId) closeThreadFilter()
      else if (threadFilter) contentFilter.search(threadFilter)
      // Drop cached PR lifecycles when the workspace changes so we don't paint
      // another project's GitHub state onto the new sidebar.
      prStatusGeneration += 1
      prLifecycleCache.clear()
      prFetchInFlight.clear()
      render()
    }),
    store.on('attention_changed', render),
    store.on('attention_changed', syncActivityButton),
    // Switches emit `projects_changed` twice; neither changes which stores are
    // orphaned. Re-scan only when a project is added, removed, or recovered.
    store.on('projects_changed', refreshOrphansIfProjectSetChanged),
  ]

  render()
  refreshOrphans()
  return () => {
    contentFilter.cancel()
    for (const timer of prBackfillRetryTimers) clearTimeout(timer)
    prBackfillRetryTimers.clear()
    prBackfillObserver?.disconnect()
    prBackfillObserver = null
    prBackfillRowsByKey.clear()
    prStatusGeneration += 1
    threadChangeGeneration += 1
    if (threadChangeTimer !== null) clearTimeout(threadChangeTimer)
    threadChangeTimer = null
    window.removeEventListener('focus', recheckStaleThreadChanges)
    document.removeEventListener('visibilitychange', recheckStaleThreadChanges)
    threadChangeCache.clear()
    threadChangeInFlight.clear()
    orphanScanGeneration += 1
    dismissContextMenu()
    renaming = null
    renamingGroup = null
    activeDrag = null
    unsubs.forEach((u) => {
      u()
    })
  }
}
