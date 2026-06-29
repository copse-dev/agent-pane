import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread, setThreadStatus } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { enqueueUserMessage } from '../controller/message-queue.ts'
import { mountConversation } from './conversation.ts'

// Component-level port of tests/e2e/queued-send-now.e2e.ts. The queued-message
// CONTROLLER (enqueue/reorder/abort/drain) is already exhaustively covered in
// controller/message-queue.test.ts, so what the e2e uniquely exercised — and
// what this ports to happy-dom — is the RENDER + WIRING: the pinned queued
// bubble, its badge, and the "Send now" button driving the controller. The
// running→abort→done→drain lifecycle stays a controller concern; here the
// drain is observed synchronously via the idle send-now path.

// Records agent.run/agent.abort so the send-now wiring is observable without an
// Electron runtime. Mirrors the stub in controller/message-queue.test.ts.
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

// Mount the real conversation view and queue one user message on the active
// thread exactly as input-bar's submit path does: addMessage, then (while the
// turn is running) enqueueUserMessage.
function mountWithQueued(status: 'idle' | 'running'): {
  store: ReturnType<typeof createStore>
  api: ReturnType<typeof fakeApi>
  threadId: string
  messageId: string
} {
  const store = createStore()
  const api = fakeApi()
  const threadId = createThread(store)
  setThreadStatus(store, threadId, status)
  const host = document.createElement('div')
  document.body.append(host)
  mountConversation(host, store, api)
  const messageId = addMessage(store, threadId, 'user', 'run me right now')
  enqueueUserMessage(store, threadId, {
    messageId,
    payload: { content: 'run me right now' },
    createdAt: 1,
  })
  return { store, api, threadId, messageId }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('queued send-now (component)', () => {
  it('renders a queued follow-up in the pinned panel, not inline, while running', () => {
    mountWithQueued('running')

    const queued = document.querySelector('.conversation-queued .msg-queued')
    assert.ok(queued, 'expected a queued message bubble')
    assert.equal(queued.querySelector('.message-queued-badge')?.textContent, 'Queued')
    assert.ok(queued.querySelector('.queued-send-now'), 'expected a Send now button')
    // The follow-up lives only in the pinned panel — the threads_changed rebuild
    // keeps it out of the scrolling message list while it's queued.
    assert.equal(document.querySelector('.messages-list .msg-queued'), null)
    assert.equal(document.querySelector('.messages-list .msg-user'), null)
  })

  it('Send now dispatches the queued message and clears the pinned panel', () => {
    const { api } = mountWithQueued('idle')

    const sendNow = document.querySelector<HTMLButtonElement>(
      '.conversation-queued .queued-send-now',
    )
    assert.ok(sendNow, 'expected a Send now button')
    sendNow.click()

    // The queued bubble + badge are gone, the pinned panel is hidden, and the
    // message now renders inline as a normal user message that was dispatched.
    assert.equal(document.querySelector('.message-queued-badge'), null)
    assert.equal(document.querySelector('.msg-queued'), null)
    assert.equal(document.querySelector<HTMLElement>('.conversation-queued')?.hidden, true)
    assert.equal(
      document.querySelector('.messages-list .msg-user .message-text')?.textContent,
      'run me right now',
    )
    assert.equal(api.runs.length, 1)
    assert.match(api.runs[0]?.[1] ?? '', /run me right now/)
  })
})
