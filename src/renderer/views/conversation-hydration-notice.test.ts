import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { AppStore } from '@shared/store/store.ts'
import { createThread } from '@shared/store/thread-helpers.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'
import { attachThreadHydration } from '../controller/thread-hydration.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

// A switched-to thread arrives as metadata only (`messages: []`,
// `messagesLoaded: false`) and hydrates asynchronously. The conversation must
// hold that window with a visible notice — saying the agent is working when it
// is — instead of an empty pane that looks like nothing is happening (#1684).

function patchActiveThread(store: AppStore, patch: Partial<Thread>): void {
  const { threads, activeThreadId } = store.getState()
  store.setState({
    threads: threads.map((t) => (t.id === activeThreadId ? { ...t, ...patch } : t)),
  })
  store.emit('threads_changed')
}

function mountUnhydratedThread(status: Thread['status']): AppStore {
  const store = createStore()
  createThread(store)
  const host = document.createElement('div')
  document.body.append(host)
  mountConversation(host, store, createFakeApi())
  patchActiveThread(store, { status, messages: [], messagesLoaded: false })
  return store
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('conversation hydration notice', () => {
  it('shows a loading notice for an unhydrated idle thread', () => {
    mountUnhydratedThread('idle')
    const notice = document.querySelector('.conversation-hydrating')
    assert.ok(notice, 'notice renders while the transcript is loading')
    assert.equal(notice.textContent, 'Loading the conversation…')
    assert.ok(
      !notice.classList.contains('conversation-hydrating-running'),
      'idle thread does not claim a live run',
    )
  })

  it('says the agent is working when the unhydrated thread is running', () => {
    mountUnhydratedThread('running')
    const notice = document.querySelector('.conversation-hydrating')
    assert.ok(notice, 'notice renders while the transcript is loading')
    assert.equal(notice.textContent, 'Agent is working — loading the conversation…')
    assert.ok(notice.classList.contains('conversation-hydrating-running'))
    const activity = document.querySelector<HTMLElement>('.agent-activity')
    assert.ok(activity, 'activity row is mounted')
    assert.equal(activity.hidden, true, 'notice replaces the live activity row while loading')
  })

  it('clears the notice once the transcript hydrates', () => {
    const store = mountUnhydratedThread('running')
    patchActiveThread(store, {
      messagesLoaded: true,
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: 'All done here.',
          toolCalls: [],
          createdAt: Date.now(),
        },
      ],
    })
    assert.equal(document.querySelector('.conversation-hydrating'), null)
    assert.ok(document.querySelector('.msg-assistant'), 'hydrated messages render in its place')
    const activity = document.querySelector<HTMLElement>('.agent-activity')
    assert.ok(activity, 'activity row is mounted')
    assert.equal(activity.hidden, false, 'live activity resumes once the transcript is in')
  })

  it('ignores agent_activity while the transcript is loading', () => {
    const store = mountUnhydratedThread('running')
    const tid = store.getState().activeThreadId
    assert.ok(tid)
    // A streamed chunk lands during the hydration window; unhiding the live
    // row would stack it under the notice that already says the agent works.
    store.emit('agent_activity', tid, 'Reading files…')
    const activity = document.querySelector<HTMLElement>('.agent-activity')
    assert.ok(activity, 'activity row is mounted')
    assert.equal(activity.hidden, true, 'the chunk must not unhide the row under the notice')
    assert.ok(document.querySelector('.conversation-hydrating'), 'notice still holds the pane')
  })

  it('renders the failure line and frees the activity row when hydration fails', async () => {
    const store = createStore()
    createThread(store)
    store.setState({ activeProjectId: 'p' })
    const api = createFakeApi()
    const failing: ApiClient = {
      ...api,
      threads: {
        ...api.threads,
        loadMessages: () => Promise.reject(new Error('disk gone')),
      },
    }
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, failing)
    const detach = attachThreadHydration(store, failing)
    patchActiveThread(store, { status: 'running', messages: [], messagesLoaded: false })
    await new Promise((r) => setTimeout(r, 0))

    const failure = document.querySelector('.conversation-hydrating-failed')
    assert.ok(failure, 'failed hydration renders the failure line')
    assert.equal(failure.textContent, 'Couldn’t load the conversation.')
    assert.equal(
      document.querySelectorAll('.conversation-hydrating').length,
      1,
      'the failure line replaces the loading notice rather than joining it',
    )
    const activity = document.querySelector<HTMLElement>('.agent-activity')
    assert.ok(activity, 'activity row is mounted')
    assert.equal(activity.hidden, false, 'failure stops suppressing the live activity row')
    detach()
  })

  it('renders no notice for a hydrated thread', () => {
    const store = createStore()
    createThread(store)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, createFakeApi())
    assert.equal(document.querySelector('.conversation-hydrating'), null)
  })
})
