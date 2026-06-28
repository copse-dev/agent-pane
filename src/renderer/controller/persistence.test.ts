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
  addEventListener: (event: string, handler: () => void) => {
    if (event === 'pagehide') pagehideHandlers.add(handler)
  },
  removeEventListener: (event: string, handler: () => void) => {
    if (event === 'pagehide') pagehideHandlers.delete(handler)
  },
}

function fakeApi(set: (key: string, value: unknown) => Promise<void>): ApiClient {
  return { storage: { get: async () => null, set } } as unknown as ApiClient
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

const tick = () => new Promise((r) => setTimeout(r, 0))
const waitDebounce = () => new Promise((r) => setTimeout(r, AUTOSAVE_DEBOUNCE_MS + 20))

test('serializedSet applies writes to the same key in submission order', async () => {
  const calls: Array<[string, unknown]> = []
  const resolvers: Array<() => void> = []
  const api = fakeApi((key, value) => {
    calls.push([key, value])
    return new Promise<void>((r) => resolvers.push(r))
  })

  const p1 = serializedSet(api, 'k', 'first')
  const p2 = serializedSet(api, 'k', 'second')

  // The second write is held back until the first one resolves.
  await tick()
  assert.deepEqual(calls, [['k', 'first']])

  resolvers[0]!()
  await p1
  await tick()
  assert.deepEqual(calls, [
    ['k', 'first'],
    ['k', 'second'],
  ])

  resolvers[1]!()
  await p2
})

test('serializedSet does not serialize across different keys', async () => {
  const calls: string[] = []
  const api = fakeApi((key) => {
    calls.push(key)
    return Promise.resolve()
  })
  await Promise.all([serializedSet(api, 'a', 1), serializedSet(api, 'b', 2)])
  assert.deepEqual([...calls].sort(), ['a', 'b'])
})

test('attachAutosave debounces a burst of events into a single save', async () => {
  const calls: Array<[string, unknown]> = []
  const api = fakeApi((key, value) => {
    calls.push([key, value])
    return Promise.resolve()
  })
  const store = createStore({ activeProjectId: 'p1', threads: [thread('t1')], projects: [] })
  const autosave = attachAutosave(store, api)

  // Fire several events synchronously, as a turn does.
  store.emit('threads_changed')
  store.emit('message_done', 'm1')
  store.emit('usage_updated', 't1')
  store.emit('todos_changed', 't1')

  // Nothing written yet (still within the debounce window).
  assert.deepEqual(calls, [])

  await waitDebounce()

  // Exactly one coalesced save: projects + threads:p1, once each.
  const keys = calls.map((c) => c[0]).sort()
  assert.deepEqual(keys, ['activeProjectId', 'projects', 'threads:p1'])
  autosave.detach()
})

test('attachAutosave persists drafts via thread_draft_changed', async () => {
  const calls: string[] = []
  const api = fakeApi((key) => {
    calls.push(key)
    return Promise.resolve()
  })
  const store = createStore({ activeProjectId: 'p1', threads: [thread('t1')], projects: [] })
  const autosave = attachAutosave(store, api)

  // Draft saves use the narrow event (not threads_changed) but must still autosave.
  store.emit('thread_draft_changed', 't1')
  assert.equal(calls.length, 0)

  await waitDebounce()
  assert.ok(calls.includes('threads:p1'))
  autosave.detach()
})

test('attachAutosave does not write the outgoing thread under the new project key after a switch', async () => {
  const calls: Array<[string, unknown]> = []
  const api = fakeApi((key, value) => {
    calls.push([key, value])
    return Promise.resolve()
  })
  const store = createStore({ activeProjectId: 'p1', threads: [thread('old')], projects: [] })
  const autosave = attachAutosave(store, api)

  // A late event from the outgoing project schedules a debounced save...
  store.emit('message_done', 'm-old')

  // ...but the project switch lands before the debounce fires.
  store.setState({ activeProjectId: 'p2', threads: [thread('new')] })

  await waitDebounce()

  // The save reads current state, so threads were written under p2 with the new
  // thread — never the outgoing 'old' thread under threads:p2, and never under p1.
  const threadWrites = calls.filter(([k]) => k.startsWith('threads:'))
  assert.deepEqual(threadWrites, [['threads:p2', [thread('new')]]])
  autosave.detach()
})

test('attachAutosave flush() bypasses the debounce timer and awaits the writes', async () => {
  let resolved = false
  const api = fakeApi(
    () =>
      new Promise<void>((r) =>
        setTimeout(() => {
          resolved = true
          r()
        }, 10),
      ),
  )
  const store = createStore({ activeProjectId: 'p1', threads: [thread('t1')], projects: [] })
  const autosave = attachAutosave(store, api)

  store.emit('threads_changed') // schedules a debounced save
  await autosave.flush() // should fire immediately and await completion
  assert.equal(resolved, true)
  autosave.detach()
})

test('attachAutosave pagehide flush triggers a final save', async () => {
  const calls: string[] = []
  const api = fakeApi((key) => {
    calls.push(key)
    return Promise.resolve()
  })
  const store = createStore({ activeProjectId: 'p1', threads: [thread('t1')], projects: [] })
  const autosave = attachAutosave(store, api)

  // Simulate window teardown firing pagehide.
  pagehideHandlers.forEach((h) => h())
  await tick()
  assert.ok(calls.includes('threads:p1'))
  autosave.detach()
})
