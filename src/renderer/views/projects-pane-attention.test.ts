// The sidebar flags a background thread that is waiting on the user (a pending
// approval or ask_user question) with a bell, so a prompt that arrives for a
// thread the user isn't looking at is discoverable instead of silently blocking.
// This is the DOM half of the feature; the gating/queueing lives in the dialog
// specs and the attention controller spec.
import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../preload/api.d.ts'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import { mountProjectsPane } from './projects-pane.ts'
import { setAttentionThreads, resetAttention } from '../controller/attention.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountActivityPanel } from './activity-panel.ts'
import type { ApprovalRequests } from './approval-dialog.ts'
import type { AskUserRequests } from './ask-user-dialog.ts'

function thread(id: string, title: string): Thread {
  return {
    id,
    title,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

// mountProjectsPane refreshes orphan stores on mount (#997).
const apiStub = ((): ApiClient => {
  const base = createFakeApi()
  return {
    ...base,
    threads: {
      ...base['threads'],
      listOrphans: async (): Promise<never[]> => [],
    },
  } satisfies ApiClient
})()

afterEach(() => {
  document.body.replaceChildren()
  resetAttention()
})

describe('projects pane SSH labels (component)', () => {
  it('shows host plus full remote path so same-basename dirs stay distinct', () => {
    const store = createStore({
      projects: [
        {
          id: 'a',
          path: '/etc/ddg',
          name: 'euw-serp-dev-testing16:ddg',
          sshHost: 'euw-serp-dev-testing16',
        },
        {
          id: 'b',
          path: '/home/ubuntu/ddg',
          name: 'euw-serp-dev-testing16:ddg',
          sshHost: 'euw-serp-dev-testing16',
        },
      ],
      activeProjectId: 'a',
      expandedProjectId: 'a',
      workspaceRoot: '/etc/ddg',
      threads: [],
      activeThreadId: null,
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountProjectsPane(host, store, apiStub)

    const names = Array.from(document.querySelectorAll('.project-name')).map((n) => n.textContent)
    assert.deepEqual(names, [
      'euw-serp-dev-testing16:/etc/ddg',
      'euw-serp-dev-testing16:/home/ubuntu/ddg',
    ])
  })
})

describe('projects pane attention bell (component)', () => {
  function mount(store: ReturnType<typeof createStore>): HTMLElement {
    const host = document.createElement('div')
    document.body.append(host)
    mountProjectsPane(host, store, apiStub)
    return host
  }

  it('renders a bell only on the thread awaiting attention', () => {
    const store = createStore({
      projects: [{ id: 'p1', path: '/proj', name: 'Proj' }],
      activeProjectId: 'p1',
      expandedProjectId: 'p1',
      workspaceRoot: '/proj',
      threads: [thread('focused', 'Focused'), thread('waiting', 'Waiting')],
      activeThreadId: 'focused',
    })
    mount(store)

    // A background thread hits an approval while the user is on another thread.
    setAttentionThreads(store, 'approval', ['waiting'])

    const rows = Array.from(document.querySelectorAll<HTMLElement>('.chat-row'))
    const byTitle = (t: string): HTMLElement | undefined =>
      rows.find((r) => r.querySelector('.chat-title')?.textContent === t)

    const waiting = byTitle('Waiting')
    const focused = byTitle('Focused')
    assert.ok(waiting?.classList.contains('needs-attention'), 'waiting row is flagged')
    assert.equal(waiting?.querySelectorAll('.chat-attention-bell').length, 1)
    assert.equal(focused?.querySelectorAll('.chat-attention-bell').length, 0)
  })

  it('drops the bell once the thread no longer needs attention', () => {
    const store = createStore({
      projects: [{ id: 'p1', path: '/proj', name: 'Proj' }],
      activeProjectId: 'p1',
      expandedProjectId: 'p1',
      workspaceRoot: '/proj',
      threads: [thread('t1', 'One')],
      activeThreadId: 't1',
    })
    mount(store)

    setAttentionThreads(store, 'ask', ['t1'])
    assert.equal(document.querySelectorAll('.chat-attention-bell').length, 1)

    setAttentionThreads(store, 'ask', [])
    assert.equal(document.querySelectorAll('.chat-attention-bell').length, 0)
  })
})

describe('projects pane Activity entry (component)', () => {
  it('counts waiting threads on the header bell and opens the Activity panel', () => {
    Object.defineProperties(window.HTMLDialogElement.prototype, {
      showModal: {
        configurable: true,
        value(this: HTMLDialogElement): void {
          this.open = true
        },
      },
      close: {
        configurable: true,
        value(this: HTMLDialogElement): void {
          this.open = false
          this.dispatchEvent(new window.Event('close'))
        },
      },
    })
    const store = createStore({
      projects: [{ id: 'p1', path: '/proj', name: 'Proj' }],
      activeProjectId: 'p1',
      expandedProjectId: 'p1',
      workspaceRoot: '/proj',
      threads: [thread('focused', 'Focused'), thread('a', 'A'), thread('b', 'B')],
      activeThreadId: 'focused',
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountProjectsPane(host, store, apiStub)
    const button = host.querySelector<HTMLButtonElement>('.projects-activity-btn')
    assert.ok(button)
    assert.equal(button.getAttribute('aria-label'), 'Activity')
    assert.equal(button.classList.contains('has-attention'), false)

    setAttentionThreads(store, 'approval', ['a'])
    setAttentionThreads(store, 'ask', ['b'])
    assert.equal(button.getAttribute('aria-label'), 'Activity: 2 threads need you')
    assert.equal(button.querySelector('.projects-activity-count')?.textContent, '2')
    assert.equal(button.classList.contains('has-attention'), true)

    const approvals: ApprovalRequests = {
      pending: () => [],
      answerOnce: () => false,
      onChange: () => () => {},
    }
    const questions: AskUserRequests = { pending: () => [], onChange: () => () => {} }
    const panel = mountActivityPanel(apiStub, store, { approvals, questions })
    button.click()
    assert.equal(panel.isOpen(), true)
    // Closing stops the panel's age tick, which would otherwise keep this file alive.
    panel.close()
  })
})
