import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ForkedHistoryResult, Thread } from '@shared/types'
import { addMessage, createThread, setThreadStatus } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { enqueueUserMessage } from './message-queue.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { forkThread } from './fork-thread.ts'

type ForkCall = [projectId: string, source: string, target: string, through: string | undefined]

function createProjectStore(): ReturnType<typeof createStore> {
  const store = createStore()
  store.setState({ activeProjectId: 'project-1' })
  return store
}

/** Records every `threads.fork` call; the rest of the surface is the demo double. */
function fakeApi(result: ForkedHistoryResult | Error = { source: 'copied', messageCount: 4 }): {
  api: ApiClient
  forks: ForkCall[]
} {
  const forks: ForkCall[] = []
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    threads: {
      ...base.threads,
      fork: (projectId: string, source: string, target: string, through?: string) => {
        forks.push([projectId, source, target, through])
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
      },
    },
  }
  return { api, forks }
}

function getThread(store: ReturnType<typeof createStore>, threadId: string): Thread {
  const thread = store.getState().threads.find((t) => t.id === threadId)
  if (!thread) throw new Error(`thread not found: ${threadId}`)
  return thread
}

/** A thread with one settled exchange, plus a second prompt and answer. */
function seedConversation(store: ReturnType<typeof createStore>): {
  threadId: string
  firstAnswerId: string
} {
  const threadId = createThread(store)
  addMessage(store, threadId, 'user', 'First question')
  const firstAnswerId = addMessage(store, threadId, 'assistant', 'First answer')
  addMessage(store, threadId, 'user', 'Second question')
  addMessage(store, threadId, 'assistant', 'Second answer')
  return { threadId, firstAnswerId }
}

test('forks the whole thread into a new active thread and seeds its history', async () => {
  const store = createProjectStore()
  const { api, forks } = fakeApi()
  const { threadId } = seedConversation(store)

  const result = await forkThread(store, api, threadId)

  assert.ok(result)
  assert.notEqual(result.threadId, threadId)
  assert.equal(store.getState().activeThreadId, result.threadId)
  const forked = getThread(store, result.threadId)
  assert.deepEqual(
    forked.messages.map((m) => m.content),
    ['First question', 'First answer', 'Second question', 'Second answer'],
  )
  // The fork is prepended so it leads the sidebar, and the source is unchanged.
  assert.equal(store.getState().threads[0]?.id, result.threadId)
  assert.equal(getThread(store, threadId).messages.length, 4)
  assert.deepEqual(forks, [['project-1', threadId, result.threadId, undefined]])
})

test('forks through a chosen message and reports the rebuilt history', async () => {
  const store = createProjectStore()
  const { api, forks } = fakeApi({ source: 'rebuilt', messageCount: 2 })
  const { threadId, firstAnswerId } = seedConversation(store)

  const result = await forkThread(store, api, threadId, { throughMessageId: firstAnswerId })

  assert.ok(result)
  assert.deepEqual(
    getThread(store, result.threadId).messages.map((m) => m.content),
    ['First question', 'First answer'],
  )
  assert.deepEqual(forks, [['project-1', threadId, result.threadId, firstAnswerId]])
  assert.equal(result.history?.source, 'rebuilt')
  assert.equal(result.droppedAttachments, false)
})

test('flags dropped attachments only when history had to be rebuilt', async () => {
  const store = createProjectStore()
  const threadId = createThread(store)
  addMessage(store, threadId, 'user', 'Check ￼ here', undefined, [
    { kind: 'file', label: 'login.ts' },
  ])
  const answerId = addMessage(store, threadId, 'assistant', 'Looks fine')
  addMessage(store, threadId, 'user', 'And now?')

  const rebuilt = await forkThread(
    store,
    fakeApi({ source: 'rebuilt', messageCount: 2 }).api,
    threadId,
    { throughMessageId: answerId },
  )
  assert.equal(rebuilt?.droppedAttachments, true)

  // A verbatim copy carries the original payload, so nothing was lost.
  const copied = await forkThread(
    store,
    fakeApi({ source: 'copied', messageCount: 5 }).api,
    threadId,
  )
  assert.equal(copied?.droppedAttachments, false)
})

test('leaves still-queued follow-ups on the source thread', async () => {
  const store = createProjectStore()
  const { api } = fakeApi()
  const threadId = createThread(store)
  addMessage(store, threadId, 'user', 'Sent already')
  setThreadStatus(store, threadId, 'running')
  const queuedId = addMessage(store, threadId, 'user', 'Still queued')
  enqueueUserMessage(store, threadId, {
    messageId: queuedId,
    payload: { content: 'Still queued' },
    createdAt: 1,
  })

  const result = await forkThread(store, api, threadId)

  assert.ok(result)
  const forked = getThread(store, result.threadId)
  assert.deepEqual(
    forked.messages.map((m) => m.content),
    ['Sent already'],
  )
  assert.equal(forked.pendingMessages, undefined)
  assert.equal(forked.status, 'idle')
  assert.equal(getThread(store, threadId).pendingMessages?.length, 1)
})

test('returns null when there is nothing to fork', async () => {
  const store = createProjectStore()
  const { api, forks } = fakeApi()
  const blankId = createThread(store)

  assert.equal(await forkThread(store, api, blankId), null)
  assert.equal(await forkThread(store, api, 'no-such-thread'), null)
  assert.equal(forks.length, 0)
})

test('keeps the fork usable when seeding its provider history fails', async () => {
  const store = createProjectStore()
  const { api } = fakeApi(new Error('disk full'))
  const { threadId } = seedConversation(store)

  const result = await forkThread(store, api, threadId)

  assert.ok(result)
  assert.equal(result.history, null)
  assert.equal(store.getState().activeThreadId, result.threadId)
})
