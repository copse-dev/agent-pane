import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  serializedSet,
  attachAutosave,
  __resetPersistenceForTest,
  AUTOSAVE_DEBOUNCE_MS,
} from './persistence.ts'
import { createStore } from '@shared/store/store.ts'
import type { Message, Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'

// attachAutosave registers a pagehide listener; provide a minimal window stub
// (node test env has no DOM).
const pagehideHandlers = new Set<() => void>()
;(globalThis as Record<string, unknown>)['window'] = {
  addEventListener: (event: string, handler: () => void): void => {
    if (event === 'pagehide') pagehideHandlers.add(handler)
  },
  removeEventListener: (event: string, handler: () => void): void => {
    if (event === 'pagehide') pagehideHandlers.delete(handler)
  },
}

interface FakeApiCalls {
  storageSets: Array<[string, unknown]>
  creates: Array<{ projectId: string; thread: Thread }>
  appends: Array<{ projectId: string; threadId: string; message: Message }>
  metas: Array<{ projectId: string; threadId: string; patch: unknown }>
  deletes: Array<{ projectId: string; threadId: string }>
}

function fakeApi(
  handlers: {
    set?: (key: string, value: unknown) => Promise<void>
    create?: (projectId: string, thread: Thread) => Promise<void>
  } = {},
): { api: ApiClient; calls: FakeApiCalls } {
  const calls: FakeApiCalls = {
    storageSets: [],
    creates: [],
    appends: [],
    metas: [],
    deletes: [],
  }
  const api = {
    storage: {
      get: async (): Promise<unknown> => null,
      set:
        handlers.set ??
        (async (key, value): Promise<void> => {
          calls.storageSets.push([key, value])
        }),
    },
    threads: {
      loadProject: async (): Promise<Thread[]> => [],
      create:
        handlers.create ??
        (async (projectId: string, thread: Thread): Promise<void> => {
          calls.creates.push({ projectId, thread })
        }),
      appendMessage: async (
        projectId: string,
        threadId: string,
        message: Message,
      ): Promise<void> => {
        calls.appends.push({ projectId, threadId, message })
      },
      updateMeta: async (projectId: string, threadId: string, patch: unknown): Promise<void> => {
        calls.metas.push({ projectId, threadId, patch })
      },
      delete: async (projectId: string, threadId: string): Promise<void> => {
        calls.deletes.push({ projectId, threadId })
      },
      catalog: async (): Promise<never[]> => [],
    },
  } as unknown as ApiClient
  return { api, calls }
}

function thread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function userMsg(id: string): Message {
  return { id, role: 'user', content: 'hi', toolCalls: [], createdAt: 10 }
}

const tick = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0))
const waitDebounce = (): Promise<unknown> =>
  new Promise((r) => setTimeout(r, AUTOSAVE_DEBOUNCE_MS + 20))

test('serializedSet applies writes to the same key in submission order', async () => {
  const calls: Array<[string, unknown]> = []
  const resolvers: Array<() => void> = []
  const { api } = fakeApi({
    set: (key, value) => {
      calls.push([key, value])
      return new Promise<void>((r) => resolvers.push(r))
    },
  })

  const p1 = serializedSet(api, 'k', 'first')
  const p2 = serializedSet(api, 'k', 'second')

  await tick()
  assert.deepEqual(calls, [['k', 'first']])

  const resolveFirst = resolvers[0]
  assert.ok(resolveFirst, 'first resolver should be registered')
  resolveFirst()
  await p1
  await tick()
  assert.deepEqual(calls, [
    ['k', 'first'],
    ['k', 'second'],
  ])

  const resolveSecond = resolvers[1]
  assert.ok(resolveSecond, 'second resolver should be registered')
  resolveSecond()
  await p2
})

test('serializedSet does not serialize across different keys', async () => {
  const calls: string[] = []
  const { api } = fakeApi({
    set: (key) => {
      calls.push(key)
      return Promise.resolve()
    },
  })
  await Promise.all([serializedSet(api, 'a', 1), serializedSet(api, 'b', 2)])
  assert.deepEqual([...calls].sort(), ['a', 'b'])
})

test('debounces a metadata burst into one create for a new thread + a projects save', async () => {
  __resetPersistenceForTest()
  const { api, calls } = fakeApi()
  const store = createStore({ activeProjectId: 'p1', threads: [thread('t1')], projects: [] })
  const autosave = attachAutosave(store, api)

  store.emit('threads_changed')
  store.emit('usage_updated', 't1')
  store.emit('todos_changed', 't1')
  store.emit('projects_changed')

  assert.equal(calls.creates.length, 0)

  await waitDebounce()

  assert.deepEqual(
    calls.creates.map((c) => [c.projectId, c.thread.id]),
    [['p1', 't1']],
  )
  assert.deepEqual(calls.metas, [])
  assert.deepEqual(calls.storageSets.map((c) => c[0]).sort(), ['activeProjectId', 'projects'])
  autosave.detach()
})

test('a metadata change on a known thread emits updateMeta, not create', async () => {
  __resetPersistenceForTest()
  const { api, calls } = fakeApi()
  const store = createStore({ activeProjectId: 'p1', threads: [thread('t1')], projects: [] })
  const autosave = attachAutosave(store, api)

  // First reconcile establishes the baseline (create t1).
  store.emit('threads_changed')
  await waitDebounce()
  assert.equal(calls.creates.length, 1)

  // Change the draft, then reconcile again — meta changed, id known → updateMeta.
  store.setState({ threads: [thread('t1', { draftPrompt: 'typing' })] })
  store.emit('thread_draft_changed', 't1')
  await waitDebounce()

  assert.equal(calls.creates.length, 1) // unchanged
  assert.deepEqual(
    calls.metas.map((m) => [m.threadId, (m.patch as { draftPrompt?: string }).draftPrompt]),
    [['t1', 'typing']],
  )
  autosave.detach()
})

test('a finalized message is appended immediately on message_done', async () => {
  __resetPersistenceForTest()
  const { api, calls } = fakeApi()
  const store = createStore({
    activeProjectId: 'p1',
    activeThreadId: 't1',
    threads: [thread('t1', { messages: [userMsg('m1')] })],
    projects: [],
  })
  const autosave = attachAutosave(store, api)

  store.emit('message_done', 'm1')
  await tick()

  assert.deepEqual(
    calls.appends.map((a) => [a.projectId, a.threadId, a.message.id]),
    [['p1', 't1', 'm1']],
  )
  autosave.detach()
})

test('a removed thread emits delete', async () => {
  __resetPersistenceForTest()
  const { api, calls } = fakeApi()
  const store = createStore({
    activeProjectId: 'p1',
    threads: [thread('t1'), thread('t2')],
    projects: [],
  })
  const autosave = attachAutosave(store, api)

  store.emit('threads_changed')
  await waitDebounce()
  assert.equal(calls.creates.length, 2)

  store.setState({ threads: [thread('t1')] })
  store.emit('threads_changed')
  await waitDebounce()

  assert.deepEqual(
    calls.deletes.map((d) => [d.projectId, d.threadId]),
    [['p1', 't2']],
  )
  autosave.detach()
})

test('skips stale writes for a thread gone after a project switch', async () => {
  __resetPersistenceForTest()
  const { api, calls } = fakeApi()
  const store = createStore({
    activeProjectId: 'p1',
    activeThreadId: 'old',
    threads: [thread('old', { messages: [userMsg('m-old')] })],
    projects: [],
  })
  const autosave = attachAutosave(store, api)

  store.emit('usage_updated', 'old')
  // Switch projects before the debounce fires.
  store.setState({ activeProjectId: 'p2', threads: [thread('new')], activeThreadId: 'new' })
  await waitDebounce()

  // Nothing is written for the outgoing 'old' thread under any project.
  assert.equal(
    calls.creates.some((c) => c.thread.id === 'old'),
    false,
  )
  assert.equal(
    calls.metas.some((m) => m.threadId === 'old'),
    false,
  )
  assert.equal(
    calls.appends.some((a) => a.threadId === 'old'),
    false,
  )
  autosave.detach()
})

test('flush() bypasses the debounce timer and awaits the writes', async () => {
  __resetPersistenceForTest()
  let resolved = false
  const { api } = fakeApi({
    create: () =>
      new Promise<void>((r) =>
        setTimeout(() => {
          resolved = true
          r()
        }, 10),
      ),
  })
  const store = createStore({ activeProjectId: 'p1', threads: [thread('t1')], projects: [] })
  const autosave = attachAutosave(store, api)

  store.emit('threads_changed')
  await autosave.flush()
  assert.equal(resolved, true)
  autosave.detach()
})

test('pagehide flush triggers a final reconcile', async () => {
  __resetPersistenceForTest()
  const { api, calls } = fakeApi()
  const store = createStore({ activeProjectId: 'p1', threads: [thread('t1')], projects: [] })
  const autosave = attachAutosave(store, api)

  pagehideHandlers.forEach((h) => {
    h()
  })
  await tick()
  assert.deepEqual(
    calls.creates.map((c) => c.thread.id),
    ['t1'],
  )
  autosave.detach()
})
