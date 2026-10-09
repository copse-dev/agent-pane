import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ForkedHistoryResult, Thread } from '@shared/types'
import {
  addMessage,
  archiveThread,
  createThread,
  switchThread,
} from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { enqueueUserMessage } from './message-queue.ts'
import { promoteSideChat, sendSideChatMessage, startSideChat } from './side-chat.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

type ForkCall = [projectId: string, source: string, target: string, through: string | undefined]

function fakeApi(result: ForkedHistoryResult | Error = { source: 'rebuilt', messageCount: 2 }): {
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

function seed(): { store: ReturnType<typeof createStore>; parentId: string; answerId: string } {
  const store = createStore()
  store.setState({ activeProjectId: 'project-1' })
  const parentId = createThread(store)
  addMessage(store, parentId, 'user', 'Why is it flaky?')
  const answerId = addMessage(store, parentId, 'assistant', 'A race.')
  return { store, parentId, answerId }
}

function thread(store: ReturnType<typeof createStore>, id: string): Thread {
  const found = store.getState().threads.find((t) => t.id === id)
  if (!found) throw new Error(`thread not found: ${id}`)
  return found
}

test('opens an empty side chat anchored on the latest message beside the main thread', async () => {
  const { store, parentId, answerId } = seed()
  const { api, forks } = fakeApi()
  const opened: string[] = []
  store.on('side_chat_open_requested', (threadId) => opened.push(threadId))

  const id = await startSideChat(store, api, parentId, { model: 'acp:codex-acp#fast' })

  assert.ok(id)
  const side = thread(store, id)
  assert.equal(side.messages.length, 0)
  assert.deepEqual(side.sideChat, { parentThreadId: parentId, anchorMessageId: answerId })
  assert.equal(side.model, 'acp:codex-acp#fast')
  // The main thread stays active; the side chat is announced for the panel.
  assert.equal(store.getState().activeThreadId, parentId)
  assert.deepEqual(opened, [id])
  assert.deepEqual(forks, [['project-1', parentId, id, answerId]])
  // The parent is untouched.
  assert.equal(thread(store, parentId).messages.length, 2)
  assert.equal(thread(store, parentId).sideChat, undefined)
})

test('can open as the active thread instead', async () => {
  const { store, parentId } = seed()
  const { api } = fakeApi()
  const id = await startSideChat(store, api, parentId, { open: 'thread' })
  assert.ok(id)
  assert.equal(store.getState().activeThreadId, id)
})

test('survives switching away while still empty', async () => {
  const { store, parentId } = seed()
  const { api } = fakeApi()
  const id = await startSideChat(store, api, parentId)
  assert.ok(id)

  switchThread(store, parentId)

  assert.ok(store.getState().threads.some((t) => t.id === id))
})

test('anchors on an earlier message when asked', async () => {
  const { store, parentId } = seed()
  const first = thread(store, parentId).messages[0]
  assert.ok(first)
  const { api, forks } = fakeApi()

  const id = await startSideChat(store, api, parentId, { anchorMessageId: first.id })

  assert.ok(id)
  assert.equal(forks[0]?.[3], first.id)
})

test('keeps the side chat when history seeding fails', async () => {
  const { store, parentId } = seed()
  const { api } = fakeApi(new Error('no sidecar'))
  const log = console.error
  console.error = (): void => {}
  try {
    const id = await startSideChat(store, api, parentId)
    assert.ok(id)
    assert.ok(store.getState().threads.some((t) => t.id === id))
  } finally {
    console.error = log
  }
})

test('refuses an empty parent, an unknown anchor, a queued anchor, and a side chat parent', async () => {
  const { store, parentId } = seed()
  const { api, forks } = fakeApi()
  const blank = createThread(store)
  assert.equal(await startSideChat(store, api, blank), null)
  assert.equal(await startSideChat(store, api, 'missing'), null)
  assert.equal(await startSideChat(store, api, parentId, { anchorMessageId: 'nope' }), null)

  const queuedId = addMessage(store, parentId, 'user', 'later')
  enqueueUserMessage(store, parentId, {
    messageId: queuedId,
    payload: { content: 'later' },
    createdAt: 1,
  })
  assert.equal(await startSideChat(store, api, parentId, { anchorMessageId: queuedId }), null)

  const sideId = await startSideChat(store, api, parentId)
  assert.ok(sideId)
  addMessage(store, sideId, 'user', 'hi')
  assert.equal(await startSideChat(store, api, sideId), null)
  assert.equal(forks.length, 1)
})

test('asking a side chat adds the question to it and runs it without touching the main thread', async () => {
  const { store, parentId } = seed()
  const base = createFakeApi()
  const runs: string[] = []
  const api: ApiClient = {
    ...base,
    threads: {
      ...base.threads,
      fork: () => Promise.resolve({ source: 'rebuilt', messageCount: 2 }),
    },
    agent: {
      ...base.agent,
      run: (_projectId: string, threadId: string): Promise<void> => {
        runs.push(threadId)
        return Promise.resolve()
      },
    },
  }
  const id = await startSideChat(store, api, parentId)
  assert.ok(id)

  assert.ok(sendSideChatMessage(store, api, id, '  What is waitForDisplayed?  '))

  assert.deepEqual(runs, [id])
  assert.deepEqual(
    thread(store, id).messages.map((m) => [m.role, m.content]),
    [['user', 'What is waitForDisplayed?']],
  )
  assert.equal(thread(store, parentId).messages.length, 2)
  assert.equal(store.getState().activeThreadId, parentId)
  assert.equal(sendSideChatMessage(store, api, id, '   '), null)
  assert.equal(sendSideChatMessage(store, api, parentId, 'not a side chat'), null)

  // An archived side chat takes no new questions until it is restored.
  archiveThread(store, id)
  assert.equal(sendSideChatMessage(store, api, id, 'Still there?'), null)
  assert.deepEqual(runs, [id])
})

test('promoting a side chat makes a thread of the parent slice plus its own turns and archives it', async () => {
  const { store, parentId, answerId } = seed()
  const { api, forks } = fakeApi()
  const id = await startSideChat(store, api, parentId, { model: 'acp:codex-acp#fast' })
  assert.ok(id)
  addMessage(store, id, 'user', 'Why?')
  addMessage(store, id, 'assistant', 'Because.')
  forks.length = 0

  const promotedId = await promoteSideChat(store, api, id)

  assert.ok(promotedId)
  const promoted = thread(store, promotedId)
  assert.equal(promoted.sideChat, undefined)
  assert.equal(promoted.model, 'acp:codex-acp#fast')
  assert.deepEqual(
    promoted.messages.map((m) => m.content),
    ['Why is it flaky?', 'A race.', 'Why?', 'Because.'],
  )
  // Fresh ids everywhere: nothing aliases the parent's or the side chat's messages.
  const taken = new Set(
    [...thread(store, parentId).messages, ...thread(store, id).messages].map((m) => m.id),
  )
  assert.ok(promoted.messages.every((m) => !taken.has(m.id)))
  assert.equal(store.getState().activeThreadId, promotedId)
  assert.ok(thread(store, id).archivedAt)
  assert.equal(thread(store, parentId).archivedAt, undefined)
  // History comes from the side chat, which holds the parent context and its own turns.
  assert.deepEqual(forks, [['project-1', id, promotedId, undefined]])
  assert.ok(answerId)
})

test('promoting an empty side chat carries the parent slice and seeds from the parent', async () => {
  const { store, parentId, answerId } = seed()
  const { api, forks } = fakeApi()
  const id = await startSideChat(store, api, parentId)
  assert.ok(id)
  forks.length = 0

  const promotedId = await promoteSideChat(store, api, id)

  assert.ok(promotedId)
  assert.deepEqual(
    thread(store, promotedId).messages.map((m) => m.content),
    ['Why is it flaky?', 'A race.'],
  )
  assert.deepEqual(forks, [['project-1', parentId, promotedId, answerId]])
})

test('promoting an orphaned empty side chat just detaches it', async () => {
  const { store, parentId } = seed()
  const { api } = fakeApi()
  const id = await startSideChat(store, api, parentId)
  assert.ok(id)
  store.setState({ threads: store.getState().threads.filter((t) => t.id !== parentId) })

  assert.equal(await promoteSideChat(store, api, id), id)
  assert.equal(thread(store, id).sideChat, undefined)
  assert.equal(await promoteSideChat(store, api, id), null)
})
