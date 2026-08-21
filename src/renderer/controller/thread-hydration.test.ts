import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Message, Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { attachThreadHydration, ensureThreadMessages, hydrationFailed } from './thread-hydration.ts'

function unloaded(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    messagesLoaded: false,
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function message(id: string): Message {
  return { id, role: 'user', content: id, toolCalls: [], createdAt: 1 }
}

/** Fake api whose `loadMessages` resolves only when the test releases it. */
function apiWithControlledLoad(): {
  api: ApiClient
  calls: string[]
  release: (threadId: string, messages: Message[]) => void
} {
  const pending = new Map<string, (messages: Message[]) => void>()
  const calls: string[] = []
  const api = createFakeApi()
  const threads = {
    ...api.threads,
    loadMessages: (_projectId: string, threadId: string): Promise<Message[]> => {
      calls.push(threadId)
      return new Promise<Message[]>((resolve) => pending.set(threadId, resolve))
    },
  }
  return {
    api: { ...api, threads },
    calls,
    release: (threadId, messages) => pending.get(threadId)?.(messages),
  }
}

test('hydrates the active thread and marks it loaded', async () => {
  const store = createStore()
  const { api, release } = apiWithControlledLoad()
  store.setState({ activeProjectId: 'p', activeThreadId: 't1', threads: [unloaded('t1')] })
  const detach = attachThreadHydration(store, api)

  release('t1', [message('m1')])
  await new Promise((r) => setTimeout(r, 0))

  const thread = store.getState().threads[0]
  assert.ok(thread)
  assert.equal(thread.messages.length, 1)
  assert.equal(thread.messagesLoaded, true)
  detach()
})

test('messages streamed while the read was in flight survive hydration', async () => {
  const store = createStore()
  const { api, release } = apiWithControlledLoad()
  store.setState({ activeProjectId: 'p', activeThreadId: 't1', threads: [unloaded('t1')] })
  const detach = attachThreadHydration(store, api)

  // The agent streams into the thread while the disk read is pending — e.g. a
  // run carried across a project switch (#1841). The disk transcript does not
  // hold that message yet; overwriting with the read would drop it.
  const [t1] = store.getState().threads
  assert.ok(t1)
  t1.messages.push(message('m-streamed'))

  release('t1', [message('m-disk')])
  await new Promise((r) => setTimeout(r, 0))

  const thread = store.getState().threads[0]
  assert.ok(thread)
  assert.deepEqual(
    thread.messages.map((m) => m.id),
    ['m-disk', 'm-streamed'],
  )
  assert.equal(thread.messagesLoaded, true)
  detach()
})

test('does not refetch a thread that is already loaded', async () => {
  const store = createStore()
  const { api, calls, release } = apiWithControlledLoad()
  store.setState({ activeProjectId: 'p', activeThreadId: 't1', threads: [unloaded('t1')] })
  const detach = attachThreadHydration(store, api)
  release('t1', [message('m1')])
  await new Promise((r) => setTimeout(r, 0))

  store.emit('threads_changed')
  await new Promise((r) => setTimeout(r, 0))

  assert.deepEqual(calls, ['t1'], 'one fetch only')
  detach()
})

test('concurrent requests for the same thread share one fetch', async () => {
  const store = createStore()
  const { api, calls, release } = apiWithControlledLoad()
  store.setState({ activeProjectId: 'p', activeThreadId: null, threads: [unloaded('t1')] })
  const detach = attachThreadHydration(store, api)

  const first = ensureThreadMessages('p', 't1')
  const second = ensureThreadMessages('p', 't1')
  release('t1', [message('m1')])
  await Promise.all([first, second])

  assert.deepEqual(calls, ['t1'])
  detach()
})

test('a transcript arriving after the user switched project is discarded', async () => {
  const store = createStore()
  const { api, release } = apiWithControlledLoad()
  store.setState({ activeProjectId: 'p', activeThreadId: 't1', threads: [unloaded('t1')] })
  const detach = attachThreadHydration(store, api)

  // The user moves to another project while the read is in flight.
  store.setState({ activeProjectId: 'other', threads: [unloaded('t1')] })
  release('t1', [message('m1')])
  await new Promise((r) => setTimeout(r, 0))

  assert.deepEqual(
    store.getState().threads[0]?.messages,
    [],
    'one project’s transcript must never land in another’s thread list',
  )
  detach()
})

test('a failed load leaves the thread retryable rather than silently empty', async () => {
  const store = createStore()
  const api = createFakeApi()
  let attempts = 0
  const failing: ApiClient = {
    ...api,
    threads: {
      ...api.threads,
      loadMessages: () => {
        attempts += 1
        return Promise.reject(new Error('disk gone'))
      },
    },
  }
  store.setState({ activeProjectId: 'p', activeThreadId: 't1', threads: [unloaded('t1')] })
  const detach = attachThreadHydration(store, failing)
  await new Promise((r) => setTimeout(r, 0))

  assert.equal(store.getState().threads[0]?.messagesLoaded, false, 'still marked unloaded')
  await ensureThreadMessages('p', 't1')
  assert.equal(attempts, 2, 'selecting the thread again retries')
  detach()
})

test('a failed load is marked, announced once, and retried on reselection', async () => {
  const store = createStore()
  const api = createFakeApi()
  let attempts = 0
  const failing: ApiClient = {
    ...api,
    threads: {
      ...api.threads,
      loadMessages: () => {
        attempts += 1
        return Promise.reject(new Error('disk gone'))
      },
    },
  }
  store.setState({
    activeProjectId: 'p',
    activeThreadId: 't1',
    threads: [unloaded('t1'), unloaded('t2', { messagesLoaded: true })],
  })
  let announcements = 0
  const offAnnounce = store.on('threads_changed', () => {
    announcements += 1
  })
  const detach = attachThreadHydration(store, failing)
  await new Promise((r) => setTimeout(r, 0))

  assert.equal(hydrationFailed('t1'), true, 'the failure is recorded for the view')
  assert.ok(announcements >= 1, 'the failure is announced so the view can rebuild')
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(attempts, 1, 'the failure announcement must not refetch in a loop')

  // Switching away and back is a fresh selection: the mark clears and the
  // ordinary hydration path retries.
  store.setState({ activeThreadId: 't2' })
  store.emit('threads_changed')
  store.setState({ activeThreadId: 't1' })
  store.emit('threads_changed')
  assert.equal(hydrationFailed('t1'), false, 'reselecting the thread clears the mark')
  assert.equal(attempts, 2, 'reselecting the thread retries the read')
  offAnnounce()
  detach()
})

test('evicts old transcripts but never the active or running ones', async () => {
  const store = createStore()
  const api = createFakeApi()
  const loading: ApiClient = {
    ...api,
    threads: {
      ...api.threads,
      loadMessages: (_p: string, threadId: string) => Promise.resolve([message(threadId)]),
    },
  }
  // Twelve threads against a budget of eight, with one of them running.
  const threads = Array.from({ length: 12 }, (_, i) =>
    unloaded(`t${String(i)}`, i === 0 ? { status: 'running' } : {}),
  )
  store.setState({ activeProjectId: 'p', activeThreadId: null, threads })
  const detach = attachThreadHydration(store, loading)

  for (const t of threads) await ensureThreadMessages('p', t.id)
  store.setState({ activeThreadId: 't11' })

  const state = store.getState()
  const resident = state.threads.filter((t) => t.messagesLoaded === true)
  assert.ok(
    resident.length <= 9,
    `expected the budget to bound residency, got ${String(resident.length)}`,
  )
  assert.equal(
    state.threads.find((t) => t.id === 't0')?.messagesLoaded,
    true,
    'running thread pinned',
  )
  assert.equal(state.threads.find((t) => t.id === 't11')?.messagesLoaded, true, 'newest kept')
  detach()
})
