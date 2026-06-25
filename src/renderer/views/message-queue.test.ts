import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread, setThreadStatus } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { drainMessageQueue, enqueueUserMessage } from '../controller/message-queue.ts'
import { mountConversation } from './conversation.ts'

// Component port of tests/e2e/message-queue.e2e.ts. A follow-up queued while the
// agent runs renders in the pinned panel, then — once the turn finishes and the
// queue drains — moves inline after the completed turn in FIFO order with the
// badge gone. The drain *ordering* is unit-tested in
// controller/message-queue.test.ts; this covers the conversation view's
// rendering of that drained state.

function fakeApi(): ApiClient & { runs: Array<[string, string]> } {
  const runs: Array<[string, string]> = []
  return {
    runs,
    agent: {
      run: (threadId: string, payload: string) => {
        runs.push([threadId, payload])
        return Promise.resolve()
      },
      abort: () => Promise.resolve(),
    },
  } as unknown as ApiClient & { runs: Array<[string, string]> }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('message queue (component)', () => {
  it('queues a follow-up while running, then drains it inline after the turn', () => {
    const store = createStore()
    const api = fakeApi()
    const threadId = createThread(store)
    setThreadStatus(store, threadId, 'running')
    const host = document.createElement('div')
    document.body.append(host)
    mountConversation(host, store, api)

    // The running turn: the user's first prompt and the assistant's reply.
    addMessage(store, threadId, 'user', 'first prompt')
    addMessage(store, threadId, 'assistant', 'working on it')

    // Queue a follow-up mid-run — it renders in the pinned panel, not the list.
    const queuedId = addMessage(store, threadId, 'user', 'queued follow up')
    enqueueUserMessage(store, threadId, {
      messageId: queuedId,
      payload: { content: 'queued follow up' },
      createdAt: 2,
    })

    assert.ok(
      document.querySelector('.conversation-queued .msg-queued'),
      'expected a queued bubble',
    )
    assert.equal(
      document.querySelectorAll('.messages-list .msg-user .message-text').length,
      1,
      'the queued follow-up stays out of the message list while queued',
    )

    // The turn finishes and the queue drains — what the agent controller does on
    // the run's `done` chunk.
    setThreadStatus(store, threadId, 'idle')
    drainMessageQueue(store, api, threadId)

    // The follow-up now renders inline after the completed turn, in FIFO order,
    // the pinned panel is empty, and no queued badge remains.
    assert.equal(document.querySelector('.message-queued-badge'), null)
    assert.equal(document.querySelector<HTMLElement>('.conversation-queued')?.hidden, true)
    const userTexts = [...document.querySelectorAll('.messages-list .msg-user .message-text')].map(
      (n) => n.textContent,
    )
    assert.deepEqual(userTexts, ['first prompt', 'queued follow up'])
    assert.equal(api.runs.length, 1)
  })
})
