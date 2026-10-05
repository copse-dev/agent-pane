import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ForkedHistoryResult, Thread } from '@shared/types'
import { addMessage, createThread, switchThread } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { enqueueUserMessage } from './message-queue.ts'
import { startSideChat } from './side-chat.ts'
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

test('opens an empty side chat anchored on the latest message and seeds only its history', async () => {
  const { store, parentId, answerId } = seed()
  const { api, forks } = fakeApi()

  const id = await startSideChat(store, api, parentId, { model: 'acp:codex-acp#fast' })

  assert.ok(id)
  const side = thread(store, id)
  assert.equal(side.messages.length, 0)
  assert.deepEqual(side.sideChat, { parentThreadId: parentId, anchorMessageId: answerId })
  assert.equal(side.model, 'acp:codex-acp#fast')
  assert.equal(store.getState().activeThreadId, id)
  assert.deepEqual(forks, [['project-1', parentId, id, answerId]])
  // The parent is untouched.
  assert.equal(thread(store, parentId).messages.length, 2)
  assert.equal(thread(store, parentId).sideChat, undefined)
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
