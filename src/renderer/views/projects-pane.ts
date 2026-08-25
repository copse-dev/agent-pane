import { el, clear } from '../dom/helpers.ts'
import { dismissContextMenu, showContextMenu, type ContextMenuEntry } from '../dom/context-menu.ts'
import { bindRenameBlur } from '../dom/rename-blur.ts'
import {
  chevronRightIcon,
  closeIcon,
  gitPullRequestIcon,
  plusIcon,
  runningStatusIcon,
  searchIcon,
  warningIcon,
} from '../dom/icons.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { OrphanProjectStore, Project, ProjectGroup } from '@shared/types'
import {
  archiveThread,
  deleteThread,
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
  addRemoteProject,
  createNewProject,
  getSidebarThreads,
  isProjectSwitchInFlight,
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
import { openAutomationSettings, openSettingsDialog } from './settings-dialog.ts'
import { showErrorToast, showToast } from './toast.ts'
import { forkThread } from '../controller/fork-thread.ts'
import { sidebarPrRefs, type SidebarThread } from '../controller/sidebar-thread.ts'
import { isThreadAwaitingAttention } from '../controller/attention.ts'
import { isSshWorkspaceEnabled } from '../controller/ssh-workspace-ui.ts'
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
  const svg = runningStatusIcon('ui-icon ui-icon-sm chat-running-status')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', label)
  svg.setAttribute('data-tooltip', label)
  svg.removeAttribute('aria-hidden')
  return svg
}

/** Single GitHub PR icon on a thread row; color encodes open / merged / closed. */
function chatPrStatus(rollup: ThreadPrRollup): HTMLElement {
  const label = describeThreadPrStatus(rollup)
  const icon = gitPullRequestIcon('ui-icon ui-icon-sm')
  icon.setAttribute('aria-hidden', 'true')
  return el(
    'span',
    {
      class: `chat-pr-status is-${rollup.kind}`,
      role: 'img',
      'aria-label': label,
      'data-tooltip': label,
    },
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
 * Trailing link on an automation heading through to that automation's setup in
 * Settings — the sidebar owns run history, the schedule editor owns the
 * configuration, and this is the seam between them. Quiet until its heading is
 * hovered or the button takes focus, like the row actions beside it.
 */
function automationSetupBtn(label: string, open: () => void): HTMLElement {
  const btn = el(
    'button',
    { type: 'button', class: 'automation-setup-btn', 'aria-label': label, title: label },
    settingsIcon('ui-icon ui-icon-sm'),
  )
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    open()
  })
  return btn
}

export function mountProjectsPane(root: HTMLElement, store: AppStore, api: ApiClient): () => void {
  const title = el('span', {}, 'Projects')
  // Toggles the thread filter row below. Filtering the sidebar's thread list is
  // the local sibling to the Cmd/Ctrl+Shift+K command palette: this narrows the
  // expanded project's threads in place, the palette jumps across everything.
  const searchToggle = el(
    'button',
    {
      class: 'projects-search-btn',
      'aria-label': 'Search threads',
      'data-tooltip': 'Search threads',
    },
    searchIcon('ui-icon ui-icon-sm'),
  )
  // One "+" entry point for every way to add a project. The remote action is
  // included only while SSH workspaces are enabled.
  const addBtn = el(
    'button',
    {
      class: 'projects-add-btn',
      'aria-label': 'Add project',
      'data-tooltip': 'New project or open a folder',
    },
    plusIcon('ui-icon ui-icon-sm'),
  )
  const header = el('div', { class: 'pane-projects-header' }, title, searchToggle, addBtn)

  // Filter input for the expanded project's threads. It lives outside `list`
  // (which render() clears on every update) so its focus and value survive
  // re-renders while the user is typing.
  let threadFilter = ''
  const searchInput = el('input', {
    type: 'text',
    class: 'projects-search-input',
    placeholder: 'Filter threads…',
    'aria-label': 'Filter threads',
    spellcheck: 'false',
    autocomplete: 'off',
  })
  const searchRow = el('div', { class: 'projects-search-row', hidden: true }, searchInput)

  const closeThreadFilter = (): void => {
    searchInput.value = ''
    threadFilter = ''
    searchRow.hidden = true
    searchToggle.classList.remove('active')
  }

  searchToggle.addEventListener('click', () => {
    if (searchRow.hidden) {
      searchRow.hidden = false
      searchToggle.classList.add('active')
      searchInput.focus()
    } else {
      closeThreadFilter()
      render()
    }
  })
  searchInput.addEventListener('input', () => {
    threadFilter = searchInput.value.trim().toLowerCase()
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
    settingsIcon(),
    'Settings',
  )
  settingsBtn.addEventListener('click', () => {
    openSettingsDialog()
  })
  root.append(header, searchRow, list, settingsBtn)

  let sshWorkspaceEnabled = false

  addBtn.addEventListener('click', () => {
    const rect = addBtn.getBoundingClientRect()
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
  // Automation history is intentionally tucked away from ordinary conversation
  // rows. Expansion is session-only: a fresh app launch returns to the quiet
  // default, while selecting an automation thread always reveals its owner.
  const expandedAutomationProjects = new Set<string>()
  const expandedAutomationSchedules = new Set<string>()
  let orphans: OrphanProjectStore[] = []

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
  // `owner/repo#number`. Fetches are coalesced; a successful (or failed) fetch
  // re-renders once so chips appear without blocking the first paint.
  const prLifecycleCache = new Map<string, { state: PrLifecycleState; fetchedAt: number }>()
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
    if (save && next) setThreadTitle(store, threadId, next)
    else render()
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

  function archiveProjectThread(projectId: string, threadId: string): void {
    // Only the active project's in-memory thread list is mutable here; other
    // projects' rows are cache-backed until switched.
    if (projectId !== store.getState().activeProjectId) return
    archiveThread(store, threadId)
  }

  function cachedPrLifecycle(key: string): PrLifecycleState | undefined {
    const entry = prLifecycleCache.get(key)
    if (!entry) return undefined
    if (Date.now() - entry.fetchedAt > PR_STATUS_CACHE_TTL_MS) return undefined
    return entry.state
  }

  function ensurePrLifecycles(refs: GithubPrRef[]): void {
    const missing = refs.filter((ref) => {
      const key = githubPrKey(ref)
      return cachedPrLifecycle(key) === undefined && !prFetchInFlight.has(key)
    })
    if (missing.length === 0) return
    const generation = prStatusGeneration
    for (const ref of missing) {
      const key = githubPrKey(ref)
      prFetchInFlight.add(key)
      void api.gh
        .prDetails(ref.owner, ref.repo, ref.number)
        .then((details) => {
          const state = details ? normalizePrLifecycleState(details.state) : 'unknown'
          prLifecycleCache.set(key, { state, fetchedAt: Date.now() })
        })
        .catch(() => {
          prLifecycleCache.set(key, { state: 'unknown', fetchedAt: Date.now() })
        })
        .finally(() => {
          prFetchInFlight.delete(key)
          if (generation === prStatusGeneration) render()
        })
    }
  }

  function rollupForThread(thread: SidebarThread): ThreadPrRollup | null {
    const refs = sidebarPrRefs(thread)
    if (refs.length === 0) return null
    ensurePrLifecycles(refs)
    const states = refs.map((ref) => cachedPrLifecycle(githubPrKey(ref)) ?? 'unknown')
    return summarizeThreadPrStatus(states, refs)
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
  function renderOrphansSection(): HTMLElement {
    const section = el('div', { class: 'orphans-section' })
    section.append(
      el(
        'div',
        { class: 'orphans-heading' },
        warningIcon('ui-icon ui-icon-sm'),
        el('span', {}, 'Recoverable threads'),
      ),
    )
    for (const orphan of orphans) {
      const count = orphan.threadCount
      const row = el(
        'div',
        { class: 'orphan-row', title: `Store ${orphan.id}` },
        el('span', { class: 'orphan-name' }, `${String(count)} thread${count === 1 ? '' : 's'}`),
      )
      const recoverBtn = el('button', { type: 'button', class: 'orphan-recover-btn' }, 'Recover…')
      recoverBtn.addEventListener('click', () => {
        void recoverOrphanProject(store, api, orphan.id).catch((err: unknown) => {
          showErrorToast('Could not recover threads', err)
        })
      })
      row.append(recoverBtn)
      section.append(row)
    }
    return section
  }

  function refreshOrphans(): void {
    void listOrphanProjects(api)
      .then((next) => {
        const changed =
          next.length !== orphans.length ||
          next.some((o, i) => {
            const prev = orphans[i]
            return !prev || o.id !== prev.id || o.threadCount !== prev.threadCount
          })
        orphans = next
        if (changed) render()
      })
      .catch((err: unknown) => {
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

  function render(): void {
    clear(list)
    const { projects, projectGroups, activeProjectId, expandedProjectId, activeThreadId } =
      store.getState()
    const expandedId = expandedProjectId ?? activeProjectId

    if (projects.length === 0 && projectGroups.length === 0 && orphans.length === 0) {
      list.append(el('div', { class: 'sidebar-empty' }, 'No projects yet. Click "+".'))
      return
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
      projectRow.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        e.stopPropagation()
        showContextMenu(e.clientX, e.clientY, [
          {
            label: 'Remove from sidebar',
            onSelect: (): void => {
              void removeProject(store, api, project.id)
            },
          },
          ...groupMenuEntries(project, projectGroups),
        ])
      })

      if (isExpanded && project.missing) {
        entry.append(projectRow, renderMissingNotice(project))
        return entry
      }

      if (isExpanded) {
        const projectLine = el('div', { class: 'project-line' })
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
        projectLine.append(projectRow, newThreadBtn)
        entry.append(projectLine)
      } else {
        entry.append(projectRow)
      }

      if (!isExpanded) return entry

      const sidebarThreads = getSidebarThreads(store, project.id)
      // When a filter is active it narrows the list by thread title and shows
      // every match (pagination is suppressed so a match can't hide behind
      // "Show more").
      const isFiltering = threadFilter.length > 0
      const matchingThreads = isFiltering
        ? sidebarThreads.filter((t) =>
            (t.title || 'New Thread').toLowerCase().includes(threadFilter),
          )
        : sidebarThreads
      const automationThreads = matchingThreads.filter((thread) => thread.automation !== undefined)
      const conversationThreads = matchingThreads.filter(
        (thread) => thread.automation === undefined,
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
      } else if (isFiltering && matchingThreads.length === 0) {
        chats.append(el('div', { class: 'sidebar-empty' }, 'No matching threads'))
      }

      /**
       * Open a schedule's setup (or, with no id, this project's schedule list).
       * Schedules are project-scoped, so a heading under a project that isn't
       * open lands on the project first — the same one-click-to-switch the New
       * thread button uses rather than editing another project's automations.
       */
      function openAutomationSetup(scheduleId?: string): void {
        if (project.id !== store.getState().activeProjectId) {
          switchProject(store, api, project.id)
          return
        }
        openAutomationSettings(scheduleId)
      }

      function renderThreadRow(
        thread: SidebarThread,
        options: { displayTitle?: string; allowRename?: boolean } = {},
      ): HTMLElement {
        const displayTitle = (options.displayTitle ?? thread.title) || 'New Thread'
        const allowRename = options.allowRename ?? true
        const scheduleId = thread.automation?.scheduleId
        const renameState = renaming !== null && renaming.threadId === thread.id ? renaming : null
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
        chatRow.addEventListener('contextmenu', (e) => {
          e.preventDefault()
          e.stopPropagation()
          showContextMenu(e.clientX, e.clientY, [
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
                forkProjectThread(project.id, thread.id)
              },
            },
            {
              label: 'Archive',
              onSelect: (): void => {
                archiveProjectThread(project.id, thread.id)
              },
            },
            // A schedule with a single run has no heading of its own, and a
            // historical run is several rows below the one that does, so every
            // automation row carries the way out to its setup.
            ...(scheduleId
              ? [
                  {
                    label: 'Automation setup…',
                    onSelect: (): void => {
                      openAutomationSetup(scheduleId)
                    },
                  },
                ]
              : []),
          ])
        })

        if (thread.status === 'running') {
          chatRow.classList.add('is-running')
          chatRow.insertBefore(runningStatus('Agent is working'), title)
        } else if (thread.unreadAt !== undefined && thread.id !== activeId) {
          chatRow.classList.add('is-unread')
          chatRow.insertBefore(
            el('span', {
              class: 'chat-unread-dot',
              role: 'img',
              'aria-label': 'Unread agent completion',
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
          chatRow.append(chatPrStatus(prRollup))
        }

        const del = el(
          'button',
          { class: 'chat-delete', 'aria-label': 'Delete thread', 'data-tooltip': 'Delete thread' },
          closeIcon('ui-icon ui-icon-sm'),
        )
        del.addEventListener('click', (e) => {
          e.stopPropagation()
          if (project.id !== activeProjectId) return
          if (sidebarThreads.length > 1) {
            void api.agent.clearHistory(project.id, thread.id)
            deleteThread(store, thread.id)
          }
        })
        chatRow.append(del)
        return chatRow
      }

      for (const thread of visibleThreads) {
        chats.append(renderThreadRow(thread))
      }

      if (hasMore) {
        const showMoreBtn = el('button', { type: 'button', class: 'chats-show-more' }, 'Show more')
        showMoreBtn.addEventListener('click', () => {
          visibleThreadCounts.set(project.id, visibleCount + SIDEBAR_THREADS_PAGE_SIZE)
          render()
        })
        chats.append(showMoreBtn)
      }

      if (automationThreads.length > 0) {
        const scheduleGroups = new Map<string, SidebarThread[]>()
        for (const thread of automationThreads) {
          const scheduleId = thread.automation?.scheduleId
          if (!scheduleId) continue
          const runs = scheduleGroups.get(scheduleId)
          if (runs) runs.push(thread)
          else scheduleGroups.set(scheduleId, [thread])
        }
        const hasActiveAutomation = automationThreads.some((thread) => thread.id === activeId)
        const attentionAutomationThreads = automationThreads.filter((thread) =>
          isThreadAwaitingAttention(thread.id),
        )
        const automationExpanded =
          isFiltering ||
          expandedAutomationProjects.has(project.id) ||
          hasActiveAutomation ||
          attentionAutomationThreads.length > 0
        const group = el('div', { class: 'automation-threads-group' })
        const toggle = el(
          'button',
          {
            type: 'button',
            class: 'automation-threads-toggle',
            'aria-expanded': automationExpanded ? 'true' : 'false',
          },
          el(
            'span',
            { class: `automation-threads-twisty${automationExpanded ? ' expanded' : ''}` },
            chevronRightIcon('ui-icon ui-icon-sm'),
          ),
          el('span', { class: 'automation-threads-title' }, 'Automations'),
          el('span', { class: 'automation-threads-count' }, String(scheduleGroups.size)),
        )
        if (automationThreads.some((thread) => thread.status === 'running')) {
          const status = runningStatusIcon('ui-icon ui-icon-sm automation-threads-running')
          status.setAttribute('role', 'img')
          status.setAttribute('aria-label', 'An automation is running')
          status.removeAttribute('aria-hidden')
          toggle.append(status)
        }
        toggle.addEventListener('click', () => {
          if (expandedAutomationProjects.has(project.id)) {
            expandedAutomationProjects.delete(project.id)
          } else {
            expandedAutomationProjects.add(project.id)
          }
          render()
        })
        group.append(
          el(
            'div',
            { class: 'automation-threads-header' },
            toggle,
            automationSetupBtn('Automation settings', () => {
              openAutomationSetup()
            }),
          ),
        )
        if (automationExpanded) {
          const automationRows = el('div', { class: 'automation-thread-rows' })
          for (const [scheduleId, runs] of scheduleGroups) {
            const firstRun = runs[0]
            if (!firstRun) continue
            if (runs.length === 1) {
              automationRows.append(renderThreadRow(firstRun))
              continue
            }

            const scheduleKey = `${project.id}\0${scheduleId}`
            const hasActiveRun = runs.some((thread) => thread.id === activeId)
            const attentionRuns = runs.filter((thread) => isThreadAwaitingAttention(thread.id))
            const showingAllRuns =
              isFiltering || expandedAutomationSchedules.has(scheduleKey) || hasActiveRun
            const scheduleRevealed = showingAllRuns || attentionRuns.length > 0
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
                {
                  class: `automation-threads-twisty${showingAllRuns ? ' expanded' : ''}`,
                },
                chevronRightIcon('ui-icon ui-icon-sm'),
              ),
              el('span', { class: 'automation-schedule-title' }, scheduleName),
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
                  openAutomationSetup(scheduleId)
                }),
              ),
            )
            if (scheduleRevealed) {
              const runRows = el('div', { class: 'automation-schedule-runs' })
              const visibleRuns = showingAllRuns ? runs : attentionRuns
              for (const thread of visibleRuns) {
                const index = runs.indexOf(thread)
                const timestamp = thread.automation?.triggeredAt
                const when = timestamp
                  ? new Date(timestamp).toLocaleString([], {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })
                  : 'Unknown time'
                runRows.append(
                  renderThreadRow(thread, {
                    displayTitle: index === 0 ? `Latest · ${when}` : when,
                    allowRename: false,
                  }),
                )
              }
              scheduleGroup.append(runRows)
            }
            automationRows.append(scheduleGroup)
          }
          group.append(automationRows)
        }
        chats.append(group)
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

    for (const node of buildProjectTree(projects, projectGroups)) {
      if (node.kind === 'group') list.append(renderGroupEntry(node.group, node.projects))
      else list.append(renderProjectEntry(node.project))
    }

    if (orphans.length > 0) list.append(renderOrphansSection())
  }

  const unsubs = [
    store.on('projects_changed', render),
    store.on('threads_changed', render),
    // Status flips on its own event (not threads_changed) so the sidebar can
    // show/hide the running-dots mark without a full thread list rewrite.
    store.on('thread_status_changed', render),
    store.on('workspace_changed', () => {
      // Drop cached PR lifecycles when the workspace changes so we don't paint
      // another project's GitHub state onto the new sidebar.
      prStatusGeneration += 1
      prLifecycleCache.clear()
      prFetchInFlight.clear()
      render()
    }),
    store.on('attention_changed', render),
    // Recovering an orphan or relocating a project changes the project set, which
    // in turn changes which store dirs count as orphaned — re-scan on that.
    store.on('projects_changed', refreshOrphans),
  ]

  render()
  refreshOrphans()
  return () => {
    prStatusGeneration += 1
    dismissContextMenu()
    renaming = null
    renamingGroup = null
    activeDrag = null
    unsubs.forEach((u) => {
      u()
    })
  }
}
