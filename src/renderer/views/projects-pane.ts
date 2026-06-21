import { el, clear } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { switchThread, deleteThread } from '@shared/store/thread-helpers.ts'
import { addProject, switchProject } from '../controller/projects.ts'

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
    const { projects, activeProjectId, threads, activeThreadId } = store.getState()

    if (projects.length === 0) {
      list.append(el('div', { class: 'sidebar-empty' }, 'No projects yet. Click "+ Open".'))
      return
    }

    for (const project of projects) {
      const isActive = project.id === activeProjectId
      const projectRow = el(
        'button',
        { class: `project-row${isActive ? ' active' : ''}`, title: project.path },
        el('span', { class: 'project-twisty' }, isActive ? '▼' : '▶'),
        el('span', { class: 'project-name' }, project.name),
      )
      projectRow.addEventListener('click', () => void switchProject(store, api, project.id))
      list.append(projectRow)

      if (!isActive) continue

      // Chats under the active project
      const chats = el('div', { class: 'chats-list' })
      for (const thread of threads) {
        const chatRow = el(
          'div',
          {
            class: `chat-row${thread.id === activeThreadId ? ' selected' : ''}`,
          },
          el('span', { class: 'chat-title' }, thread.title || 'New Thread'),
        )
        chatRow.addEventListener('click', () => switchThread(store, thread.id))

        const del = el('button', { class: 'chat-delete', 'aria-label': 'Delete thread' }, '✕')
        del.addEventListener('click', (e) => {
          e.stopPropagation()
          if (threads.length > 1) {
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
