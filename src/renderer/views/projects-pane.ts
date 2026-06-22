import { el, clear } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { openNewThread, deleteThread } from '@shared/store/thread-helpers.ts'
import {
  addProject,
  getSidebarThreads,
  isProjectSwitchInFlight,
  switchProject,
  switchProjectThread,
} from '../controller/projects.ts'

export function mountProjectsPane(root: HTMLElement, store: AppStore, api: ApiClient): () => void {
  const title = el('span', {}, 'Projects')
  const openBtn = el(
    'button',
    { class: 'projects-open-btn', 'aria-label': 'Open project' },
    '+ Open',
  )
  const header = el('div', { class: 'pane-projects-header' }, title, openBtn)
  const list = el('div', { class: 'projects-list' })
  root.append(header, list)

  openBtn.addEventListener('click', () => {
    void addProject(store, api)
  })

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
      const chats = el('div', { class: 'chats-list' })
      if (sidebarThreads.length === 0 && isProjectSwitchInFlight(store, project.id)) {
        chats.append(el('div', { class: 'sidebar-empty chats-loading' }, 'Loading…'))
      }
      for (const thread of sidebarThreads) {
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
