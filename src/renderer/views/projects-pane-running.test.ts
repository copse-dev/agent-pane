// Sidebar shows an animated three-dot status mark to the left of a thread
// title while that thread's agent is running (status === 'running').
import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { setThreadStatus } from '@shared/store/thread-helpers.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountProjectsPane } from './projects-pane.ts'

function thread(id: string, title: string, status: Thread['status'] = 'idle'): Thread {
  return {
    id,
    title,
    status,
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

const apiStub = {} as unknown as ApiClient

afterEach(() => {
  document.body.replaceChildren()
})

describe('projects pane running status (component)', () => {
  function mount(store: ReturnType<typeof createStore>): HTMLElement {
    const host = document.createElement('div')
    document.body.append(host)
    mountProjectsPane(host, store, apiStub)
    return host
  }

  function rowByTitle(title: string): HTMLElement | undefined {
    return Array.from(document.querySelectorAll<HTMLElement>('.chat-row')).find(
      (r) => r.querySelector('.chat-title')?.textContent === title,
    )
  }

  it('renders animated dots only on running threads, left of the title', () => {
    const store = createStore({
      projects: [{ id: 'p1', path: '/proj', name: 'Proj' }],
      activeProjectId: 'p1',
      expandedProjectId: 'p1',
      workspaceRoot: '/proj',
      threads: [thread('idle', 'Idle'), thread('busy', 'Busy', 'running')],
      activeThreadId: 'idle',
    })
    mount(store)

    const idle = rowByTitle('Idle')
    const busy = rowByTitle('Busy')
    assert.ok(idle && busy)

    assert.equal(idle.classList.contains('is-running'), false)
    assert.equal(idle.querySelectorAll('.chat-running-status').length, 0)

    assert.ok(busy.classList.contains('is-running'))
    const dots = busy.querySelector('.chat-running-status')
    assert.ok(dots)
    assert.equal(dots.getAttribute('data-icon'), 'running-status')
    assert.equal(dots.getAttribute('aria-label'), 'Agent is working')
    assert.equal(dots.querySelectorAll('path').length, 3)

    const title = busy.querySelector('.chat-title')
    assert.ok(title)
    assert.notEqual(
      dots.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING,
      0,
      'dots must sit before the title in DOM order',
    )
  })

  it('shows and hides the mark when thread status flips', () => {
    const store = createStore({
      projects: [{ id: 'p1', path: '/proj', name: 'Proj' }],
      activeProjectId: 'p1',
      expandedProjectId: 'p1',
      workspaceRoot: '/proj',
      threads: [thread('t1', 'One')],
      activeThreadId: 't1',
    })
    mount(store)

    assert.equal(document.querySelectorAll('.chat-running-status').length, 0)

    setThreadStatus(store, 't1', 'running')
    const runningRow = rowByTitle('One')
    assert.ok(runningRow?.classList.contains('is-running'))
    assert.equal(document.querySelectorAll('.chat-running-status').length, 1)

    setThreadStatus(store, 't1', 'idle')
    assert.equal(document.querySelectorAll('.chat-running-status').length, 0)
    assert.equal(rowByTitle('One')?.classList.contains('is-running'), false)
  })
})
