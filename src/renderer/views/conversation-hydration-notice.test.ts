import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { AppStore } from '@shared/store/store.ts'
import { createThread } from '@shared/store/thread-helpers.ts'
import type { Thread } from '@shared/types'
import { mountConversation } from './conversation.ts'
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

  it('renders no notice for a hydrated thread', () => {
    const store = createStore()
    createThread(store)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, createFakeApi())
    assert.equal(document.querySelector('.conversation-hydrating'), null)
  })
})
