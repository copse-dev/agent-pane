import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createStore } from '@shared/store/store.ts'
import type { SupervisedTaskSummary } from '@shared/types/supervised-task.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountSupervisedTasks } from './supervised-tasks.ts'

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

describe('supervised tasks', () => {
  it('inspects a blocked task, preserves literal error text, and resumes through the shared API', async () => {
    const task: SupervisedTaskSummary = {
      taskId: 'task-1',
      projectId: 'project-1',
      threadId: 'thread-1',
      handler: 'long_horizon_continue',
      state: 'blocked',
      updatedAt: 1,
      lastError: 'Interrupted <img src=x> execution; inspect before resuming',
      attempt: 1,
      maxAttempts: 2,
    }
    let tasks = [task]
    const resumes: string[][] = []
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      supervisor: {
        ...base.supervisor,
        list: async () => ({ tasks }),
        get: async () => ({ task }),
        resume: async (projectId, threadId, taskId) => {
          resumes.push([projectId, threadId, taskId])
          tasks = []
          return { task: { ...task, state: 'completed' } }
        },
      },
    }
    const root = document.createElement('div')
    const dispose = mountSupervisedTasks(root, createStore({ activeProjectId: 'project-1' }), api)
    await flush()
    assert.equal(root.querySelector('.supervised-task-reason')?.textContent, task.lastError)
    assert.equal(root.querySelector('img'), null)
    const resume = root.querySelector<HTMLButtonElement>('.supervised-task-resume')
    assert.ok(resume)
    resume.click()
    assert.ok(resume.disabled)
    await flush()
    assert.deepEqual(resumes, [['project-1', 'thread-1', 'task-1']])
    assert.equal(root.querySelector('.supervised-tasks-section')?.hasAttribute('hidden'), true)
    dispose()
  })

  it('shows resume failures and never offers replay for a lost shell process', async () => {
    const task: SupervisedTaskSummary = {
      taskId: 'task-1',
      projectId: 'project-1',
      threadId: 'thread-1',
      handler: 'long_horizon_continue',
      state: 'blocked',
      updatedAt: 1,
    }
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      supervisor: {
        ...base.supervisor,
        list: async () => ({
          tasks: [task, { ...task, taskId: 'shell', handler: 'shell_process', state: 'failed' }],
        }),
        resume: async () => {
          throw new Error('Permissions changed; schedule new work')
        },
      },
    }
    const root = document.createElement('div')
    const dispose = mountSupervisedTasks(root, createStore({ activeProjectId: 'project-1' }), api)
    await flush()
    assert.equal(root.querySelectorAll('.supervised-task-resume').length, 1)
    root.querySelector<HTMLButtonElement>('.supervised-task-resume')?.click()
    await flush()
    assert.match(root.querySelector('[role="status"]')?.textContent ?? '', /Permissions changed/)
    assert.equal(root.querySelector<HTMLButtonElement>('.supervised-task-resume')?.disabled, false)
    dispose()
  })

  it('lists active project tasks and removes one after cancellation', async () => {
    const task: SupervisedTaskSummary = {
      taskId: 'task-1',
      projectId: 'project-1',
      threadId: 'thread-1',
      handler: 'long_horizon_continue',
      state: 'waiting',
      updatedAt: 1,
    }
    let tasks = [task]
    const cancellations: string[] = []
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      supervisor: {
        ...base.supervisor,
        list: async (): Promise<{ tasks: SupervisedTaskSummary[] }> => ({ tasks }),
        cancel: async (
          _projectId: string,
          taskId: string,
        ): Promise<{ task: SupervisedTaskSummary | null }> => {
          cancellations.push(taskId)
          tasks = []
          return { task: { ...task, state: 'cancelled' } }
        },
        onChanged: () => (): void => {},
      },
    }
    const store = createStore({ activeProjectId: 'project-1' })
    const root = document.createElement('div')

    mountSupervisedTasks(root, store, api)
    await flush()

    assert.equal(root.querySelector('.supervised-tasks-section')?.hasAttribute('hidden'), false)
    assert.equal(
      root.querySelector('.supervised-task-label')?.textContent,
      'Long task continuation',
    )
    assert.equal(root.querySelector('.supervised-task-state')?.textContent, 'waiting')

    const cancel = root.querySelector('.supervised-task-cancel')
    assert.ok(cancel)
    assert.ok(cancel.querySelector('svg[data-icon="close"]'))
    assert.equal(cancel.textContent, '')
    cancel.dispatchEvent(new Event('click'))
    await flush()

    assert.deepEqual(cancellations, ['task-1'])
    assert.equal(root.querySelector('.supervised-tasks-section')?.hasAttribute('hidden'), true)
  })
})
