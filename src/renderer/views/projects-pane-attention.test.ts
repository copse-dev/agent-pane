// The sidebar flags a background thread that is waiting on the user (a pending
// approval or ask_user question) with a bell, so a prompt that arrives for a
// thread the user isn't looking at is discoverable instead of silently blocking.
// This is the DOM half of the feature; the gating/queueing lives in the dialog
// specs and the attention controller spec.
import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountProjectsPane } from './projects-pane.ts'
import { setAttentionThreads, resetAttention } from '../controller/attention.ts'

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

const apiStub = {} as unknown as ApiClient

afterEach(() => {
  document.body.replaceChildren()
  resetAttention()
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
