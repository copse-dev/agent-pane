import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serializedSet, attachAutosave, AUTOSAVE_DEBOUNCE_MS } from './persistence.ts'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
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
  threadSaves: Array<{ kind: 'one' | 'project'; projectId: string; payload: unknown }>
}

function fakeApi(handlers: {
  set?: (key: string, value: unknown) => Promise<void>
  saveOne?: (projectId: string, thread: Thread) => Promise<void>
  saveProject?: (projectId: string, threads: Thread[]) => Promise<void>
}): { api: ApiClient; calls: FakeApiCalls } {
  const calls: FakeApiCalls = { storageSets: [], threadSaves: [] }
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
      saveOne:
        handlers.saveOne ??
        (async (projectId, thread): Promise<void> => {
          calls.threadSaves.push({ kind: 'one', projectId, payload: thread })
        }),
      saveProject:
        handlers.saveProject ??
        (async (projectId, threads): Promise<void> => {
          calls.threadSaves.push({ kind: 'project', projectId, payload: threads })
        }),
    },
  } as unknown as ApiClient
  return { api, calls }
}

function thread(id: string): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
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

test('attachAutosave debounces a burst of events into a single full project save', async () => {
  const { api, calls } = fakeApi({})
  const store = createStore({ activeProjectId: 'p1', threads: [thread('t1')], projects: [] })
  const autosave = attachAutosave(store, api)

  store.emit('threads_changed')
  store.emit('message_done', 'm1')
  store.emit('usage_updated', 't1')
  store.emit('todos_changed', 't1')

  assert.deepEqual(calls.storageSets, [])
  assert.deepEqual(calls.threadSaves, [])

  await waitDebounce()

  const storageKeys = calls.storageSets.map((c) => c[0]).sort()
  assert.deepEqual(storageKeys, ['activeProjectId', 'projects'])
  assert.deepEqual(calls.threadSaves, [
    { kind: 'project', projectId: 'p1', payload: [thread('t1')] },
  ])
  autosave.detach()
})

test('attachAutosave persists drafts via a single-thread save', async () => {
  const { api, calls } = fakeApi({})
  const store = createStore({ activeProjectId: 'p1', threads: [thread('t1')], projects: [] })
  const autosave = attachAutosave(store, api)

  store.emit('thread_draft_changed', 't1')
  assert.equal(calls.threadSaves.length, 0)

  await waitDebounce()
  assert.equal(calls.threadSaves.length, 1)
  const draftSave = calls.threadSaves[0]
  assert.ok(draftSave)
  assert.equal(draftSave.kind, 'one')
  assert.equal(draftSave.projectId, 'p1')
  assert.deepEqual(draftSave.payload, thread('t1'))
  assert.deepEqual(calls.storageSets, [])
  autosave.detach()
})

test('attachAutosave skips stale single-thread saves after a project switch', async () => {
  const { api, calls } = fakeApi({})
  const store = createStore({
    activeProjectId: 'p1',
    activeThreadId: 'old',
    threads: [thread('old')],
    projects: [],
  })
  const autosave = attachAutosave(store, api)

  store.emit('usage_updated', 'old')
  store.setState({ activeProjectId: 'p2', threads: [thread('new')], activeThreadId: 'new' })

  await waitDebounce()

  // The outgoing thread is no longer in memory for p2, so nothing is written under p2.
  assert.deepEqual(calls.threadSaves, [])
  autosave.detach()
})

test('attachAutosave flush() bypasses the debounce timer and awaits the writes', async () => {
  let resolved = false
  const { api } = fakeApi({
    saveProject: () =>
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

test('attachAutosave pagehide flush triggers a final save', async () => {
  const { api, calls } = fakeApi({})
  const store = createStore({ activeProjectId: 'p1', threads: [thread('t1')], projects: [] })
  const autosave = attachAutosave(store, api)

  pagehideHandlers.forEach((h) => {
    h()
  })
  await tick()
  assert.equal(calls.threadSaves.length, 1)
  assert.equal(calls.threadSaves[0]?.kind, 'project')
  autosave.detach()
})
