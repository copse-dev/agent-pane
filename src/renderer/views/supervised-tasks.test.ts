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
