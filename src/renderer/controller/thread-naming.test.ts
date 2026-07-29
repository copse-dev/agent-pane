import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { AppStore } from '@shared/store/store.ts'
import { getThreadById, setThreadTitle } from '@shared/store/thread-helpers.ts'
import type { Message, Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { maybeNameThread } from './thread-naming.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

function requireThread(store: AppStore, id: string): Thread {
  const found = getThreadById(store, id)
  if (!found) throw new Error(`expected thread '${id}' to exist`)
  return found
}

function newThread(id: string, messages: Message[] = []): Thread {
  return {
    id,
    title: 'New Thread',
    status: 'running',
    messages,
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

function userMessage(content: string): Message {
  return {
    id: 'u1',
    role: 'user',
    content,
    toolCalls: [],
    createdAt: 1,
  }
}

function apiWithTitle(suggest: (text: string) => Promise<string | null>): {
  api: ApiClient
  titleCalls: string[]
} {
  const titleCalls: string[] = []
  const api = ((): ApiClient => {
    const base = createFakeApi()
    return {
      ...base,
      agent: {
        ...base['agent'],
        suggestTitle: async (text: string): Promise<string | null> => {
          titleCalls.push(text)
          return suggest(text)
        },
      },
    } satisfies ApiClient
  })()
  return { api, titleCalls }
}

test('maybeNameThread suggests a title from the first user message', async () => {
  const store = createStore({
    threads: [newThread('t-name', [userMessage('Add a login button')])],
    activeThreadId: 't-name',
  })
  const { api, titleCalls } = apiWithTitle(async () => 'Generated Title')

  maybeNameThread(store, api, 't-name')
  await new Promise((r) => setTimeout(r, 0))

  assert.deepEqual(titleCalls, ['Add a login button'])
  assert.equal(requireThread(store, 't-name').title, 'Generated Title')
})

test('maybeNameThread falls back to first words when suggestTitle fails', async () => {
  const store = createStore({
    threads: [newThread('t-fallback', [userMessage('Fix the flicker please now')])],
    activeThreadId: 't-fallback',
  })
  const { api } = apiWithTitle(async () => {
    throw new Error('no small-tasks model')
  })

  maybeNameThread(store, api, 't-fallback')
  await new Promise((r) => setTimeout(r, 0))

  assert.equal(requireThread(store, 't-fallback').title, 'Fix the flicker please now')
})

test('maybeNameThread is a no-op when the title is already set', async () => {
  const named = newThread('t-named', [userMessage('Already named')])
  named.title = 'Custom Title'
  const store = createStore({ threads: [named], activeThreadId: 't-named' })
  const { api, titleCalls } = apiWithTitle(async () => 'Should Not Apply')

  maybeNameThread(store, api, 't-named')
  await new Promise((r) => setTimeout(r, 0))

  assert.deepEqual(titleCalls, [])
  assert.equal(requireThread(store, 't-named').title, 'Custom Title')
})

test('maybeNameThread does not overwrite a rename that lands while suggestTitle is in flight', async () => {
  const store = createStore({
    threads: [newThread('t-race', [userMessage('Race me')])],
    activeThreadId: 't-race',
  })
  let resolveTitle!: (value: string) => void
  const { api, titleCalls } = apiWithTitle(
    () =>
      new Promise<string>((resolve) => {
        resolveTitle = resolve
      }),
  )

  maybeNameThread(store, api, 't-race')
  setThreadTitle(store, 't-race', 'User Renamed')
  resolveTitle('Late Suggestion')
  await new Promise((r) => setTimeout(r, 0))

  assert.deepEqual(titleCalls, ['Race me'])
  assert.equal(requireThread(store, 't-race').title, 'User Renamed')
})

test('maybeNameThread only attempts once per thread', async () => {
  const store = createStore({
    threads: [newThread('t-once', [userMessage('Name me once')])],
    activeThreadId: 't-once',
  })
  const { api, titleCalls } = apiWithTitle(async () => 'Once')

  maybeNameThread(store, api, 't-once')
  await new Promise((r) => setTimeout(r, 0))
  // Reset title as if a later path tried again; the in-memory guard must hold.
  setThreadTitle(store, 't-once', 'New Thread')
  maybeNameThread(store, api, 't-once')
  await new Promise((r) => setTimeout(r, 0))

  assert.deepEqual(titleCalls, ['Name me once'])
  assert.equal(requireThread(store, 't-once').title, 'New Thread')
})
