import type { ApiClient } from '../../preload/api.d.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { SupervisedTaskSummary } from '@shared/types/supervised-task.ts'
import { clear, el } from '../dom/helpers.ts'

function taskLabel(handler: string): string {
  if (handler === 'long_horizon_continue') return 'Long task continuation'
  return handler.replaceAll('_', ' ')
}

export function mountSupervisedTasks(
  listRoot: HTMLElement,
  store: AppStore,
  api: ApiClient,
): () => void {
  const section = el('section', { class: 'supervised-tasks-section', hidden: true })
  const header = el('div', { class: 'agent-tasks-section-header' }, 'Background tasks')
  const list = el('div', { class: 'supervised-tasks-list' })
  section.append(header, list)
  listRoot.append(section)
  let loadToken = 0

  function render(tasks: SupervisedTaskSummary[]): void {
    clear(list)
    section.hidden = tasks.length === 0
    for (const task of tasks) {
      const dot = el('span', {
        class: 'supervised-task-dot',
        'aria-hidden': 'true',
        'data-state': task.state,
      })
      const copy = el(
        'span',
        { class: 'supervised-task-copy' },
        el('span', { class: 'supervised-task-label' }, taskLabel(task.handler)),
        el('span', { class: 'supervised-task-state' }, task.state),
      )
      const cancel = el(
        'button',
        {
          type: 'button',
          class: 'supervised-task-cancel',
          title: 'Cancel task',
          'aria-label': `Cancel ${taskLabel(task.handler)}`,
        },
        '×',
      )
      cancel.addEventListener('click', () => {
        cancel.disabled = true
        void api.supervisor
          .cancel(task.projectId, task.taskId)
          .then(() => refresh())
          .catch(() => {
            cancel.disabled = false
          })
      })
      list.append(
        el(
          'div',
          {
            class: 'supervised-task-row',
            'data-task-id': task.taskId,
            'data-state': task.state,
          },
          dot,
          copy,
          cancel,
        ),
      )
    }
  }

  async function refresh(): Promise<void> {
    const projectId = store.getState().activeProjectId
    const token = ++loadToken
    if (!projectId) {
      render([])
      return
    }
    const result = await api.supervisor.list(projectId)
    if (token !== loadToken || projectId !== store.getState().activeProjectId) return
    render(result.tasks)
  }

  const unsubs = [
    store.on('projects_changed', () => {
      void refresh()
    }),
    api.supervisor.onChanged((projectId) => {
      if (projectId === store.getState().activeProjectId) void refresh()
    }),
  ]
  void refresh()

  return () => {
    loadToken++
    for (const unsubscribe of unsubs) unsubscribe()
    section.remove()
  }
}
