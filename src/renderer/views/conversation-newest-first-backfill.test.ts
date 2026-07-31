import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

// rebuildForThread (a thread switch / initial load) renders newest-first: the
// most recent window of messages paints immediately, then the rest of the
// history backfills above it in chunks scheduled via requestAnimationFrame.
// The test harness's rAF shim (tests/setup-dom.ts) runs callbacks synchronously,
// so by the time mountConversation returns here the whole backfill has already
// unwound — these tests pin the *outcome* (every message present, in the
// original oldest-to-newest order) rather than the scheduling itself, which is
// only observable with real frame timing.

function fakeApi(): ApiClient {
  return ((): ApiClient => {
    const base = createFakeApi()
    return {
      ...base,
      agent: {
        ...base['agent'],
        run: () => Promise.resolve(),
        abort: () => Promise.resolve(),
      },
    } satisfies ApiClient
  })()
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('newest-first thread backfill on load', () => {
  it('renders a long thread completely, in oldest-to-newest order', () => {
    const store = createStore()
    const threadId = createThread(store)
    // Comfortably more than the initial render window (40) so the backward
    // fill actually has to run more than once.
    const total = 97
    const ids: string[] = []
    for (let i = 0; i < total; i++) {
      ids.push(
        addMessage(store, threadId, i % 2 === 0 ? 'user' : 'assistant', `message ${String(i)}`),
      )
    }

    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const rendered = Array.from(host.querySelectorAll<HTMLElement>('[data-message-id]'))
    assert.equal(rendered.length, total, 'every message should end up rendered')
    assert.deepEqual(
      rendered.map((el) => el.dataset['messageId']),
      ids,
      'messages should be in their original oldest-to-newest order',
    )
  })

  it('renders a short thread (within the initial window) exactly as before', () => {
    const store = createStore()
    const threadId = createThread(store)
    const ids = [
      addMessage(store, threadId, 'user', 'hello'),
      addMessage(store, threadId, 'assistant', 'hi there'),
    ]

    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const rendered = Array.from(host.querySelectorAll<HTMLElement>('[data-message-id]'))
    assert.deepEqual(
      rendered.map((el) => el.dataset['messageId']),
      ids,
    )
  })

  it('a live-streamed message still appends after a completed backfill', () => {
    const store = createStore()
    const threadId = createThread(store)
    const total = 45
    const ids: string[] = []
    for (let i = 0; i < total; i++) {
      ids.push(addMessage(store, threadId, 'assistant', `message ${String(i)}`))
    }

    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, fakeApi())

    const newId = addMessage(store, threadId, 'user', 'just now')

    const rendered = Array.from(host.querySelectorAll<HTMLElement>('[data-message-id]'))
    assert.deepEqual(
      rendered.map((el) => el.dataset['messageId']),
      [...ids, newId],
    )
  })
})
