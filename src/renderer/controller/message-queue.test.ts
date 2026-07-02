import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Message, Thread } from '@shared/types'
import { at } from '@shared/array-utils.ts'
import {
  addMessage,
  createThread,
  setQueuePaused,
  setThreadStatus,
  setThreadTodos,
} from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  dispatchAgentRun,
  drainMessageQueue,
  enqueueUserMessage,
  movePendingUserMessagesToEnd,
  queuedMessageIds,
  queuedPayloadText,
  removeQueuedMessage,
  resumePendingQueues,
  sendQueuedMessageNow,
  updateQueuedMessageText,
} from './message-queue.ts'

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

function getThread(store: ReturnType<typeof createStore>, threadId: string): Thread {
  const thread = store.getState().threads.find((t) => t.id === threadId)
  if (!thread) throw new Error(`thread not found: ${threadId}`)
  return thread
}

function firstRun(api: { runs: Array<[string, string]> }): [string, string] {
  const run = api.runs[0]
  if (!run) throw new Error('expected at least one agent run')
  return run
}

test('enqueueUserMessage appends to thread.pendingMessages and emits message_queued', () => {
  const store = createStore()
  const api = fakeApi()
  const threadId = createThread(store)
  const queued: string[] = []
  store.on('message_queued', (_tid, messageId) => queued.push(messageId))

  enqueueUserMessage(store, threadId, {
    messageId: 'msg-1',
    payload: { content: 'follow up' },
    createdAt: 1,
  })

  const thread = getThread(store, threadId)
  const pending = thread.pendingMessages ?? []
  assert.equal(pending.length, 1)
  assert.equal(at(pending, 0).messageId, 'msg-1')
  assert.deepEqual(queued, ['msg-1'])
  assert.equal(api.runs.length, 0)
})

test('drainMessageQueue dispatches the next payload when idle', () => {
  const store = createStore()
  const api = fakeApi()
  const threadId = createThread(store)
  enqueueUserMessage(store, threadId, {
    messageId: 'msg-1',
    payload: { content: 'queued prompt', priorTodos: [] },
    createdAt: 1,
  })

  drainMessageQueue(store, api, threadId)

  const thread = getThread(store, threadId)
  assert.equal(thread.status, 'running')
  assert.equal(thread.pendingMessages, undefined)
  assert.equal(api.runs.length, 1)
  const run = firstRun(api)
  assert.equal(run[0], threadId)
  assert.match(run[1], /queued prompt/)
})

test('drainMessageQueue moves pending user messages after the completed turn', () => {
  const store = createStore()
  const api = fakeApi()
  const threadId = createThread(store)
  const firstMessageId = addMessage(store, threadId, 'user', 'first prompt')
  const queuedMessageId = addMessage(store, threadId, 'user', 'queued follow up')
  const assistantMessageId = addMessage(store, threadId, 'assistant', 'first response')
  enqueueUserMessage(store, threadId, {
    messageId: queuedMessageId,
    payload: { content: 'queued follow up' },
    createdAt: 1,
  })

  drainMessageQueue(store, api, threadId)

  const thread = getThread(store, threadId)
  assert.deepEqual(
    thread.messages.map((message) => message.id),
    [firstMessageId, assistantMessageId, queuedMessageId],
  )
})

test('movePendingUserMessagesToEnd preserves queued FIFO order', () => {
  const messages: Message[] = [
    { id: 'user-1', role: 'user', content: 'first', toolCalls: [], createdAt: 1 },
    { id: 'queued-1', role: 'user', content: 'queued 1', toolCalls: [], createdAt: 2 },
    { id: 'queued-2', role: 'user', content: 'queued 2', toolCalls: [], createdAt: 3 },
    { id: 'assistant-1', role: 'assistant', content: 'response', toolCalls: [], createdAt: 4 },
  ]

  const reordered = movePendingUserMessagesToEnd(
    [...messages],
    [
      { messageId: 'queued-1', payload: { content: 'queued 1' }, createdAt: 2 },
      { messageId: 'queued-2', payload: { content: 'queued 2' }, createdAt: 3 },
    ],
  )

  assert.deepEqual(
    reordered.map((message) => message.id),
    ['user-1', 'assistant-1', 'queued-1', 'queued-2'],
  )
})

test('drainMessageQueue refreshes priorTodos from the live thread state', () => {
  const store = createStore()
  const api = fakeApi()
  const threadId = createThread(store)
  enqueueUserMessage(store, threadId, {
    messageId: 'msg-1',
    payload: { content: 'next', priorTodos: [{ id: 'old', content: 'old', status: 'pending' }] },
    createdAt: 1,
  })
  setThreadTodos(store, threadId, [{ id: 'live', content: 'live', status: 'pending' }])

  drainMessageQueue(store, api, threadId)

  const payload = JSON.parse(firstRun(api)[1]) as { priorTodos: Array<{ id: string }> }
  assert.deepEqual(payload.priorTodos, [{ id: 'live', content: 'live', status: 'pending' }])
})

test('drainMessageQueue does nothing while the thread is running', () => {
  const store = createStore()
  const api = fakeApi()
  const threadId = createThread(store)
  setThreadStatus(store, threadId, 'running')
  enqueueUserMessage(store, threadId, {
    messageId: 'msg-1',
    payload: { content: 'wait' },
    createdAt: 1,
  })

  drainMessageQueue(store, api, threadId)

  assert.equal(api.runs.length, 0)
  assert.equal(store.getState().threads.find((t) => t.id === threadId)?.pendingMessages?.length, 1)
})

test('dispatchAgentRun marks the thread running and sends payload', () => {
  const store = createStore()
  const api = fakeApi()
  const threadId = createThread(store)

  dispatchAgentRun(store, api, threadId, { content: 'go' })

  assert.equal(store.getState().threads.find((t) => t.id === threadId)?.status, 'running')
  assert.equal(api.runs.length, 1)
})

test('resumePendingQueues drains idle threads with pending messages', () => {
  const store = createStore()
  const api = fakeApi()
  const threadId = createThread(store)
  enqueueUserMessage(store, threadId, {
    messageId: 'msg-1',
    payload: { content: 'resume me' },
    createdAt: 1,
  })

  resumePendingQueues(store, api)

  assert.equal(api.runs.length, 1)
  assert.equal(store.getState().threads.find((t) => t.id === threadId)?.status, 'running')
})

test('queuedMessageIds returns pending message ids', () => {
  const thread = {
    pendingMessages: [
      { messageId: 'a', payload: { content: '1' }, createdAt: 1 },
      { messageId: 'b', payload: { content: '2' }, createdAt: 2 },
    ],
  }
  assert.deepEqual([...queuedMessageIds(thread)].sort(), ['a', 'b'])
})

test('queuedPayloadText extracts text from string and array payloads', () => {
  assert.equal(queuedPayloadText({ content: 'plain' }), 'plain')
  assert.equal(
    queuedPayloadText({
      content: [
        { type: 'image', dataUrl: 'data:img' },
        { type: 'text', text: 'with image' },
      ],
    }),
    'with image',
  )
})

test('drainMessageQueue does nothing while the queue is paused', () => {
  const store = createStore()
  const api = fakeApi()
  const threadId = createThread(store)
  enqueueUserMessage(store, threadId, {
    messageId: 'msg-1',
    payload: { content: 'paused' },
    createdAt: 1,
  })
  setQueuePaused(store, threadId, true)

  drainMessageQueue(store, api, threadId)

  assert.equal(api.runs.length, 0)
  assert.equal(store.getState().threads.find((t) => t.id === threadId)?.pendingMessages?.length, 1)
})

test('updateQueuedMessageText edits the payload text and the displayed bubble', () => {
  const store = createStore()
  const threadId = createThread(store)
  const messageId = addMessage(store, threadId, 'user', 'original')
  enqueueUserMessage(store, threadId, {
    messageId,
    payload: { content: 'original', invokedSkills: [] },
    createdAt: 1,
  })

  updateQueuedMessageText(store, threadId, messageId, 'edited prompt')

  const thread = getThread(store, threadId)
  assert.equal(thread.pendingMessages?.[0]?.payload.content, 'edited prompt')
  assert.equal(thread.messages.find((m) => m.id === messageId)?.content, 'edited prompt')
})

test('removeQueuedMessage drops the pending entry and user bubble', () => {
  const store = createStore()
  const threadId = createThread(store)
  const firstMessageId = addMessage(store, threadId, 'user', 'first prompt')
  const queuedMessageId = addMessage(store, threadId, 'user', 'queued follow up')
  enqueueUserMessage(store, threadId, {
    messageId: queuedMessageId,
    payload: { content: 'queued follow up' },
    createdAt: 1,
  })

  removeQueuedMessage(store, threadId, queuedMessageId)

  const thread = getThread(store, threadId)
  assert.equal(thread.pendingMessages, undefined)
  assert.deepEqual(
    thread.messages.map((message) => message.id),
    [firstMessageId],
  )
})

test('removeQueuedMessage is a no-op for a message that is not queued', () => {
  const store = createStore()
  const threadId = createThread(store)
  const messageId = addMessage(store, threadId, 'user', 'sent prompt')

  removeQueuedMessage(store, threadId, messageId)

  const thread = getThread(store, threadId)
  assert.equal(thread.messages.length, 1)
  assert.equal(thread.pendingMessages, undefined)
})

test('removeQueuedMessage keeps remaining queued messages in order', () => {
  const store = createStore()
  const threadId = createThread(store)
  const firstQueuedId = addMessage(store, threadId, 'user', 'first queued')
  const secondQueuedId = addMessage(store, threadId, 'user', 'second queued')
  enqueueUserMessage(store, threadId, {
    messageId: firstQueuedId,
    payload: { content: 'first queued' },
    createdAt: 1,
  })
  enqueueUserMessage(store, threadId, {
    messageId: secondQueuedId,
    payload: { content: 'second queued' },
    createdAt: 2,
  })

  removeQueuedMessage(store, threadId, firstQueuedId)

  const thread = getThread(store, threadId)
  assert.deepEqual(
    thread.pendingMessages?.map((item) => item.messageId),
    [secondQueuedId],
  )
  assert.equal(
    thread.messages.some((message) => message.id === firstQueuedId),
    false,
  )
  assert.equal(
    thread.messages.some((message) => message.id === secondQueuedId),
    true,
  )
})

test('updateQueuedMessageText preserves images when editing an array payload', () => {
  const store = createStore()
  const threadId = createThread(store)
  const messageId = addMessage(store, threadId, 'user', 'original')
  enqueueUserMessage(store, threadId, {
    messageId,
    payload: {
      content: [
        { type: 'image', dataUrl: 'data:img' },
        { type: 'text', text: 'original' },
      ],
    },
    createdAt: 1,
  })

  updateQueuedMessageText(store, threadId, messageId, 'edited')

  const content = getThread(store, threadId).pendingMessages?.[0]?.payload.content
  assert.deepEqual(content, [
    { type: 'image', dataUrl: 'data:img' },
    { type: 'text', text: 'edited' },
  ])
})

test('sendQueuedMessageNow reorders to the front and aborts the running thread', () => {
  const store = createStore()
  const api = fakeApi()
  const threadId = createThread(store)
  setThreadStatus(store, threadId, 'running')
  enqueueUserMessage(store, threadId, {
    messageId: 'first',
    payload: { content: 'first' },
    createdAt: 1,
  })
  enqueueUserMessage(store, threadId, {
    messageId: 'second',
    payload: { content: 'second' },
    createdAt: 2,
  })

  sendQueuedMessageNow(store, api, threadId, 'second')

  const thread = getThread(store, threadId)
  assert.deepEqual(
    thread.pendingMessages?.map((p) => p.messageId),
    ['second', 'first'],
  )
  assert.deepEqual(api.aborts, [threadId])
  assert.equal(api.runs.length, 0)
})

test('sendQueuedMessageNow reorders but does not abort a running remote agent', () => {
  const store = createStore({ settings: { model: 'remote-agent:cursor' } })
  const api = fakeApi()
  const threadId = createThread(store)
  setThreadStatus(store, threadId, 'running')
  enqueueUserMessage(store, threadId, {
    messageId: 'first',
    payload: { content: 'first' },
    createdAt: 1,
  })
  enqueueUserMessage(store, threadId, {
    messageId: 'second',
    payload: { content: 'second' },
    createdAt: 2,
  })

  sendQueuedMessageNow(store, api, threadId, 'second')

  const thread = getThread(store, threadId)
  assert.deepEqual(
    thread.pendingMessages?.map((p) => p.messageId),
    ['second', 'first'],
  )
  // Remote runs must not be cancelled by a follow-up — it stays queued for the
  // same agent and drains after the current run finishes.
  assert.deepEqual(api.aborts, [])
  assert.equal(api.runs.length, 0)
})

test('sendQueuedMessageNow lifts pause and drains immediately when idle', () => {
  const store = createStore()
  const api = fakeApi()
  const threadId = createThread(store)
  enqueueUserMessage(store, threadId, {
    messageId: 'msg-1',
    payload: { content: 'go now' },
    createdAt: 1,
  })
  setQueuePaused(store, threadId, true)

  sendQueuedMessageNow(store, api, threadId, 'msg-1')

  const thread = getThread(store, threadId)
  assert.equal(thread.queuePaused, undefined)
  assert.equal(thread.status, 'running')
  assert.equal(api.runs.length, 1)
  assert.match(firstRun(api)[1], /go now/)
})

test('resumePendingQueues clears a stale pause then drains', () => {
  const store = createStore()
  const api = fakeApi()
  const threadId = createThread(store)
  enqueueUserMessage(store, threadId, {
    messageId: 'msg-1',
    payload: { content: 'resume me' },
    createdAt: 1,
  })
  setQueuePaused(store, threadId, true)

  resumePendingQueues(store, api)

  const thread = getThread(store, threadId)
  assert.equal(thread.queuePaused, undefined)
  assert.equal(api.runs.length, 1)
})

test('resumePendingQueues resets a stale running status when the queue is empty', () => {
  const store = createStore()
  const api = fakeApi()
  const threadId = createThread(store)
  setThreadStatus(store, threadId, 'running')

  resumePendingQueues(store, api)

  const thread = getThread(store, threadId)
  assert.equal(thread.status, 'idle')
  assert.equal(api.runs.length, 0)
})
