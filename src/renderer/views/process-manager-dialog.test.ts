import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { afterEach, before, test } from 'node:test'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { patchPreviewDialog } from '../attachments/preview-dialog.test-support.ts'
import { dismissContextMenu } from '../dom/context-menu.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountConfirmDialog } from './confirm-dialog.ts'
import { mountProcessManagerDialog } from './process-manager-dialog.ts'

before(patchPreviewDialog)
afterEach(() => {
  dismissContextMenu()
  document.body.replaceChildren()
})

function thread(id: string): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

function menuItem(label: string): HTMLButtonElement {
  const item = [...document.querySelectorAll<HTMLButtonElement>('.context-menu-item')].find(
    (button) => button.textContent === label,
  )
  assert.ok(item, `expected ${label} menu action`)
  return item
}

test('managed rows jump to their thread and stop by handle; shared rows stay read-only', async () => {
  const store = createStore({
    projects: [{ id: 'project-a', path: '/a', name: 'A' }],
    activeProjectId: 'project-a',
    expandedProjectId: 'project-a',
    threads: [thread('thread-a'), thread('thread-b')],
    activeThreadId: 'thread-b',
  })
  const stopped: string[] = []
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    processManager: {
      ...base.processManager,
      snapshot: async () => ({
        sampledAt: Date.now(),
        activeRunThreadIds: [],
        processes: [
          {
            pid: 1,
            startedAt: 1,
            label: 'Copse main',
            type: 'Main',
            threadId: null,
            cpuPercent: 0,
            memoryMiB: 1,
          },
          {
            pid: 42,
            startedAt: 1,
            label: 'Terminal',
            type: 'Terminal',
            threadId: 'thread-a',
            projectId: 'project-a',
            managed: { kind: 'terminal', id: 'terminal-a' },
            cpuPercent: 0,
            memoryMiB: 2,
          },
        ],
      }),
    },
    terminal: {
      ...base.terminal,
      destroy: async (id) => {
        stopped.push(id)
      },
    },
  }
  mountConfirmDialog()
  const open = mountProcessManagerDialog(api, store)
  open()
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(document.querySelector('tr[data-pid="1"] .process-manager-actions-button'), null)
  const actions = document.querySelector<HTMLButtonElement>(
    'tr[data-pid="42"] .process-manager-actions-button',
  )
  assert.ok(actions)
  actions.click()
  menuItem('Jump to thread').click()
  assert.equal(store.getState().activeThreadId, 'thread-a')
  assert.equal(document.querySelector<HTMLDialogElement>('#process-manager-dialog')?.open, false)

  open()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const row = document.querySelector<HTMLTableRowElement>('tr[data-pid="42"]')
  assert.ok(row)
  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  menuItem('Stop terminal').click()
  document.querySelector<HTMLButtonElement>('#confirm-dialog .confirm-dialog-confirm')?.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(stopped, ['terminal-a'])
  document.querySelector<HTMLDialogElement>('#process-manager-dialog')?.close()
})

test('running-thread and background-task actions keep their thread scope', async () => {
  const running = thread('thread-a')
  running.status = 'running'
  const store = createStore({
    projects: [{ id: 'project-a', path: '/a', name: 'A' }],
    activeProjectId: 'project-a',
    expandedProjectId: 'project-a',
    threads: [running],
    activeThreadId: 'thread-a',
  })
  const aborted: string[] = []
  const stopped: string[][] = []
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    agent: {
      ...base.agent,
      abort: async (threadId) => {
        aborted.push(threadId)
      },
    },
    processManager: {
      snapshot: async () => ({
        sampledAt: Date.now(),
        activeRunThreadIds: ['thread-a'],
        processes: [
          {
            pid: 43,
            startedAt: 1,
            label: 'pnpm dev',
            type: 'Background task',
            threadId: 'thread-a',
            projectId: 'project-a',
            managed: {
              kind: 'background',
              id: 'task-a',
              projectId: 'project-a',
              threadId: 'thread-a',
            },
            cpuPercent: 1,
            memoryMiB: 5,
          },
        ],
      }),
      stopBackground: async (...args) => {
        stopped.push(args)
        return true
      },
    },
  }
  mountConfirmDialog()
  const open = mountProcessManagerDialog(api, store)
  open()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(document.querySelector('.process-manager-activity')?.hasAttribute('hidden'), false)
  const activityItem = document.querySelector<HTMLButtonElement>('.process-manager-activity-item')
  assert.ok(activityItem)
  assert.match(activityItem.textContent, /Working.*thread-a/)
  assert.equal(activityItem.getAttribute('aria-label'), 'Open thread thread-a')
  activityItem.dispatchEvent(
    new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
  )
  menuItem('Stop agent run').click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(aborted, ['thread-a'])

  const actions = document.querySelector<HTMLButtonElement>(
    'tr[data-pid="43"] .process-manager-actions-button',
  )
  assert.ok(actions)
  actions.click()
  menuItem('Stop agent run').click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(aborted, ['thread-a', 'thread-a'])

  actions.click()
  menuItem('Stop background task').click()
  document.querySelector<HTMLButtonElement>('#confirm-dialog .confirm-dialog-confirm')?.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(stopped, [['task-a', 'project-a', 'thread-a']])
  document.querySelector<HTMLDialogElement>('#process-manager-dialog')?.close()
})
