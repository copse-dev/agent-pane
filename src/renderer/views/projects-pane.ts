import { el, clear } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { openNewThread, deleteThread } from '@shared/store/thread-helpers.ts'
import {
  addProject,
  getSidebarThreads,
  isProjectSwitchInFlight,
  paginateSidebarThreads,
  SIDEBAR_THREADS_PAGE_SIZE,
  switchProject,
  switchProjectThread,
} from '../controller/projects.ts'
import { openSettingsDialog } from './settings-dialog.ts'

const ICON_SIZE = '16'
const SVG_NS = 'http://www.w3.org/2000/svg'

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
  const header = el('div', { class: 'pane-projects-header' }, title, openBtn)
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

  const visibleThreadCounts = new Map<string, number>()

  function render() {
    clear(list)
    const { projects, activeProjectId, expandedProjectId, activeThreadId } = store.getState()
    const expandedId = expandedProjectId ?? activeProjectId

    if (projects.length === 0) {
      list.append(el('div', { class: 'sidebar-empty' }, 'No projects yet. Click "+ Open".'))
      return
    }

    for (const project of projects) {
      const isExpanded = project.id === expandedId
      const projectRow = el(
        'button',
        { class: `project-row${isExpanded ? ' active' : ''}`, title: project.path },
        el('span', { class: 'project-twisty' }, isExpanded ? '▼' : '▶'),
        el('span', { class: 'project-name' }, project.name),
      )
      projectRow.addEventListener('click', () => switchProject(store, api, project.id))

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
        const chatRow = el(
          'div',
          {
            class: `chat-row${thread.id === activeThreadId && project.id === activeProjectId ? ' selected' : ''}`,
          },
          el('span', { class: 'chat-title' }, thread.title || 'New Thread'),
        )
        chatRow.addEventListener('click', () =>
          switchProjectThread(store, api, project.id, thread.id),
        )

        const del = el('button', { class: 'chat-delete', 'aria-label': 'Delete thread' }, '✕')
        del.addEventListener('click', (e) => {
          e.stopPropagation()
          if (project.id !== activeProjectId) return
          if (sidebarThreads.length > 1) {
            void api.agent.clearHistory(thread.id)
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
  }

  const unsubs = [
    store.on('projects_changed', render),
    store.on('threads_changed', render),
    store.on('workspace_changed', render),
  ]

  render()
  return () => unsubs.forEach((u) => u())
}
