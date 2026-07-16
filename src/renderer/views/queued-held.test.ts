import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread, setThreadStatus } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { enqueueUserMessage } from '../controller/message-queue.ts'
import { mountConversation } from './conversation.ts'

// C2 held-state UI (decisions 5 & 16). A hook-originated message downgraded to
// held renders with a distinct "Held" badge and a "Release" action (not the plain
// "Send now" of a normal queued item); clicking Release un-holds it and submits.
// Component-tier per docs/testing-strategy.md: the drain-skip + release semantics
// are unit-tested in controller/message-queue.test.ts; this covers the view's
// rendering of the held state and that the release control is wired.

function fakeApi(): ApiClient & { runs: Array<[string, string]>; aborts: string[] } {
  const runs: Array<[string, string]> = []
  const aborts: string[] = []
  return {
    runs,
    aborts,
    agent: {
      run: (threadId: string, payload: string) => {
        runs.push([threadId, payload])
        return Promise.resolve()
      },
      abort: (threadId: string) => {
        aborts.push(threadId)
        return Promise.resolve()
      },
    },
  } as unknown as ApiClient & { runs: Array<[string, string]>; aborts: string[] }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('held queued message (component)', () => {
  it('renders a Held badge + Release action for a held hook message', () => {
    const store = createStore()
    const api = fakeApi()
    const threadId = createThread(store)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, api)

    const messageId = addMessage(store, threadId, 'user', 'late hook follow-up')
    enqueueUserMessage(store, threadId, {
      messageId,
      payload: { content: 'late hook follow-up' },
      createdAt: 1,
      origin: { kind: 'hook', hookId: 'todo-closeout', event: 'stop' },
      epoch: 'epoch-stale',
      autoDispatch: false,
    })

    const heldItem = document.querySelector<HTMLElement>(
      '.conversation-queued .msg-queued.msg-held',
    )
    assert.ok(heldItem, 'expected a held queued bubble')
    assert.equal(heldItem.dataset['hookId'], 'todo-closeout', 'hook provenance on the DOM node')
    assert.equal(
      document.querySelector('.msg-held .message-queued-badge')?.textContent,
      'Held',
      'held items badge as "Held", not "Queued"',
    )
    assert.ok(document.querySelector('.msg-held .queued-release'), 'expected a Release action')
    // A held item does not get the plain "Send now" affordance — release is the path.
    assert.equal(document.querySelector('.msg-held .queued-send-now'), null)
  })

  it('Release un-holds and dispatches the held message', () => {
    const store = createStore()
    const api = fakeApi()
    const threadId = createThread(store)
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, api)

    const messageId = addMessage(store, threadId, 'user', 'release me')
    enqueueUserMessage(store, threadId, {
      messageId,
      payload: { content: 'release me' },
      createdAt: 1,
      origin: { kind: 'hook', hookId: 'todo-closeout', event: 'stop' },
      epoch: 'epoch-stale',
      autoDispatch: false,
    })
    setThreadStatus(store, threadId, 'idle')

    const releaseBtn = document.querySelector<HTMLButtonElement>('.msg-held .queued-release')
    assert.ok(releaseBtn, 'expected a Release button')
    releaseBtn.click()

    assert.equal(api.runs.length, 1, 'release dispatches the held message')
    assert.match(api.runs[0]?.[1] ?? '', /release me/)
    const thread = store.getState().threads.find((t) => t.id === threadId)
    assert.equal(
      thread?.pendingMessages ?? undefined,
      undefined,
      'the released item leaves the queue',
    )
    assert.notEqual(thread?.currentEpoch, 'epoch-stale', 'release starts a fresh turn tree')
  })
})
