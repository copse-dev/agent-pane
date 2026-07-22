import { el, clear } from '../dom/helpers.ts'
import { dismissContextMenu, showContextMenu } from '../dom/context-menu.ts'
import {
  chevronRightIcon,
  closeIcon,
  gitPullRequestIcon,
  runningStatusIcon,
  warningIcon,
} from '../dom/icons.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { OrphanProjectStore, Project, Thread } from '@shared/types'
import {
  archiveThread,
  deleteThread,
  openNewThread,
  setThreadTitle,
} from '@shared/store/thread-helpers.ts'
import { githubPrKey, type GithubPrRef } from '@shared/git/github-pr-url.ts'
import {
  collectThreadPrRefs,
  describeThreadPrStatus,
  normalizePrLifecycleState,
  summarizeThreadPrStatus,
  type PrLifecycleState,
  type ThreadPrRollup,
} from '@shared/git/thread-pr-status.ts'
import {
  addProject,
  addRemoteProject,
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
import { openSettingsDialog } from './settings-dialog.ts'
import { showErrorToast } from './toast.ts'
import { isThreadAwaitingAttention } from '../controller/attention.ts'
import { isSshWorkspaceEnabled } from '../controller/ssh-workspace-ui.ts'

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
      title: label,
    },
    icon,
  )
}

function settingsIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'titlebar-btn-icon')
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

export function mountProjectsPane(root: HTMLElement, store: AppStore, api: ApiClient): () => void {
  const title = el('span', {}, 'Projects')
  const openBtn = el(
    'button',
    { class: 'projects-open-btn', 'aria-label': 'Open project' },
    '+ Open',
  )
  const openRemoteBtn = el(
    'button',
    { class: 'projects-open-remote-btn', 'aria-label': 'Open remote project', hidden: true },
    '+ Remote',
  )
  const header = el('div', { class: 'pane-projects-header' }, title, openBtn, openRemoteBtn)
  const list = el('div', { class: 'projects-list' })
  const settingsBtn = el(
    'button',
    { class: 'projects-settings-btn', 'aria-label': 'Settings' },
    settingsIcon(),
    'Settings',
  )
  settingsBtn.addEventListener('click', () => {
    openSettingsDialog()
  })
  root.append(header, list, settingsBtn)

  openBtn.addEventListener('click', () => {
    void addProject(store, api)
  })

  openRemoteBtn.addEventListener('click', () => {
    void addRemoteProject(store, api).catch((err: unknown) => {
      showErrorToast('Could not open remote folder', err)
    })
  })

  const syncRemoteOpenVisibility = (): void => {
    void isSshWorkspaceEnabled(api).then((enabled) => {
      openRemoteBtn.hidden = !enabled
    })
  }
  syncRemoteOpenVisibility()
  store.on('settings_changed', syncRemoteOpenVisibility)

  const visibleThreadCounts = new Map<string, number>()
  let orphans: OrphanProjectStore[] = []

  // Inline rename state survives `render()` (which rebuilds the chat list).
  let renaming: { threadId: string; draft: string } | null = null

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

  function rollupForThread(
    thread: Pick<Thread, 'messages' | 'remoteAgentLink'>,
  ): ThreadPrRollup | null {
    const refs = collectThreadPrRefs(thread)
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

  function render(): void {
    clear(list)
    const { projects, activeProjectId, expandedProjectId, activeThreadId } = store.getState()
    const expandedId = expandedProjectId ?? activeProjectId

    if (projects.length === 0 && orphans.length === 0) {
      list.append(el('div', { class: 'sidebar-empty' }, 'No projects yet. Click "+ Open".'))
      return
    }

    for (const project of projects) {
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
            onSelect: () => {
              void removeProject(store, api, project.id)
            },
          },
        ])
      })

      if (isExpanded && project.missing) {
        list.append(projectRow)
        list.append(renderMissingNotice(project))
        continue
      }

      if (isExpanded) {
        const projectLine = el('div', { class: 'project-line' })
        const newThreadBtn = el(
          'button',
          {
            type: 'button',
            class: 'project-new-thread-btn',
            'aria-label': 'New thread',
            title: 'New thread',
          },
          '+',
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
        list.append(projectLine)
      } else {
        list.append(projectRow)
      }

      if (!isExpanded) continue

      const sidebarThreads = getSidebarThreads(store, project.id)
      const visibleLimit = visibleThreadCounts.get(project.id) ?? SIDEBAR_THREADS_PAGE_SIZE
      const activeId = project.id === activeProjectId ? activeThreadId : null
      const { visibleThreads, visibleCount, hasMore } = paginateSidebarThreads(
        sidebarThreads,
        visibleLimit,
        activeId,
      )
      if (visibleCount !== visibleLimit) {
        visibleThreadCounts.set(project.id, visibleCount)
      }

      const chats = el('div', { class: 'chats-list' })
      if (sidebarThreads.length === 0 && isProjectSwitchInFlight(store, project.id)) {
        chats.append(el('div', { class: 'sidebar-empty chats-loading' }, 'Loading…'))
      }
      for (const thread of visibleThreads) {
        const displayTitle = thread.title || 'New Thread'
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
          input.addEventListener('blur', () => {
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
          title.addEventListener('dblclick', (e) => {
            e.stopPropagation()
            beginThreadRename(thread.id, displayTitle)
          })
        }
        const chatRow = el(
          'div',
          {
            class: `chat-row${thread.id === activeThreadId && project.id === activeProjectId ? ' selected' : ''}`,
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
            {
              label: 'Rename',
              onSelect: () => {
                beginThreadRename(thread.id, displayTitle)
              },
            },
            {
              label: 'Archive',
              onSelect: () => {
                archiveProjectThread(project.id, thread.id)
              },
            },
          ])
        })

        if (thread.status === 'running') {
          chatRow.classList.add('is-running')
          chatRow.insertBefore(runningStatus('Agent is working'), title)
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
          { class: 'chat-delete', 'aria-label': 'Delete thread' },
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
        chats.append(chatRow)
      }

      if (hasMore) {
        const showMoreBtn = el('button', { type: 'button', class: 'chats-show-more' }, 'Show more')
        showMoreBtn.addEventListener('click', () => {
          visibleThreadCounts.set(project.id, visibleCount + SIDEBAR_THREADS_PAGE_SIZE)
          render()
        })
        chats.append(showMoreBtn)
      }

      list.append(chats)
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
    unsubs.forEach((u) => {
      u()
    })
  }
}
