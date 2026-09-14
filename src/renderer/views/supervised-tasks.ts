import type { ApiClient } from '../../preload/api.d.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { SupervisedTaskSummary } from '@shared/types/supervised-task.ts'
import { clear, el } from '../dom/helpers.ts'
import { closeIcon } from '../dom/icons.ts'

function taskLabel(handler: string): string {
  if (handler === 'long_horizon_continue') return 'Long task continuation'
  return handler.replaceAll('_', ' ')
}

export function mountSupervisedTasks(
  listRoot: HTMLElement,
  store: AppStore,
  api: ApiClient,
): () => void {
  const section = el('section', {
    class: 'supervised-tasks-section terminal-rail-section',
    hidden: true,
  })
  const header = el(
    'div',
    { class: 'agent-tasks-section-header terminal-rail-section-header' },
    'Background tasks',
  )
  const list = el('div', {
    class: 'supervised-tasks-list terminal-rail-section-list',
  })
  section.append(header, list)
  listRoot.append(section)
  let loadToken = 0
  const expanded = new Set<string>()
  const feedback = el('p', { class: 'supervised-task-feedback', role: 'status', hidden: true })
  section.append(feedback)

  function report(error: unknown): void {
    feedback.textContent =
      error instanceof Error ? error.message : 'Unable to update background tasks'
    feedback.hidden = false
  }

  function render(tasks: SupervisedTaskSummary[]): void {
    clear(list)
    section.hidden = tasks.length === 0
    for (const task of tasks) {
      const dot = el('span', {
        class: 'supervised-task-dot',
        'aria-hidden': 'true',
        'data-state': task.state,
      })
      const copy = el('details', { class: 'supervised-task-copy' })
      copy.open = expanded.has(task.taskId)
      const label = el(
        'summary',
        { class: 'supervised-task-summary' },
        el('span', { class: 'supervised-task-label' }, taskLabel(task.handler)),
        el('span', { class: 'supervised-task-state' }, task.state),
      )
      const detail = el('div', { class: 'supervised-task-detail' })
      function showDetail(value: SupervisedTaskSummary): void {
        clear(detail)
        if (value.lastError)
          detail.append(el('p', { class: 'supervised-task-reason' }, value.lastError))
        if (value.attempt !== undefined && value.maxAttempts !== undefined) {
          detail.append(
            el('p', {}, `Attempt ${String(value.attempt)} of ${String(value.maxAttempts)}`),
          )
        }
        if (value.resultRef) detail.append(el('p', {}, value.resultRef.ref))
        if (
          (value.state === 'blocked' || value.state === 'failed') &&
          value.handler !== 'shell_process'
        ) {
          const resume = el(
            'button',
            {
              type: 'button',
              class: 'ui-btn ui-btn-secondary supervised-task-resume',
            },
            'Resume',
          )
          resume.addEventListener('click', () => {
            resume.disabled = true
            feedback.hidden = true
            void api.supervisor
              .resume(value.projectId, value.threadId, value.taskId)
              .then(() => refresh())
              .catch((error: unknown) => {
                resume.disabled = false
                report(error)
              })
          })
          detail.append(resume)
        }
      }
      showDetail(task)
      copy.append(label, detail)
      copy.addEventListener('toggle', () => {
        if (!copy.open) {
          expanded.delete(task.taskId)
          return
        }
        expanded.add(task.taskId)
        void api.supervisor
          .get(task.projectId, task.threadId, task.taskId)
          .then(({ task: latest }) => {
            if (latest && copy.isConnected) showDetail(latest)
          })
          .catch(report)
      })
      const cancel = el(
        'button',
        {
          type: 'button',
          class: 'supervised-task-cancel',
          title: 'Cancel task',
          'aria-label': `Cancel ${taskLabel(task.handler)}`,
        },
        closeIcon('ui-icon ui-icon-sm'),
      )
      cancel.addEventListener('click', () => {
        cancel.disabled = true
        void api.supervisor
          .cancel(task.projectId, task.taskId)
          .then(() => refresh())
          .catch((error: unknown) => {
            cancel.disabled = false
            report(error)
          })
      })
      cancel.hidden =
        task.state === 'failed' || task.state === 'completed' || task.state === 'cancelled'
      list.append(
        el(
          'div',
          {
            class: 'supervised-task-row',
            'data-task-id': task.taskId,
            'data-terminal-rail-row': '',
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
    try {
      const result = await api.supervisor.list(projectId)
      if (token !== loadToken || projectId !== store.getState().activeProjectId) return
      render(result.tasks)
    } catch (error) {
      if (token === loadToken) report(error)
    }
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
