import '../../../tests/setup-dom.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { AppStore } from '@shared/store/store.ts'
import {
  addMessage,
  appendToken,
  getThreadById,
  markThreadUnread,
  setThreadStatus,
  setThreadTodos,
} from '@shared/store/thread-helpers.ts'
import type { StreamChunk, Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { startAgentController } from './agent.ts'
import {
  adoptBackgroundThreads,
  backgroundProjectOf,
  carryRunningThreads,
  dropProjectBackgroundThreads,
} from './background-threads.ts'

// A project switch replaces `state.threads` wholesale. Threads with live runs
// are carried into `state.backgroundThreads` instead of being dropped, so agent
// chunks keep landing and finalized messages keep persisting (#1841).

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

test('carryRunningThreads carries only running threads, idempotently', () => {
  const store = createStore()
  const running = thread('t-run', { status: 'running' })
  const idle = thread('t-idle')
  carryRunningThreads(store, 'project-a', [running, idle])
  carryRunningThreads(store, 'project-a', [running, idle])
  assert.deepEqual(store.getState().backgroundThreads, [
    { projectId: 'project-a', thread: running },
  ])
})

test('adoptBackgroundThreads prefers the carried copy and releases it', () => {
  const store = createStore()
  const carried = thread('t1', {
    status: 'running',
    messages: [{ id: 'm1', role: 'assistant', content: 'streamed', toolCalls: [], createdAt: 2 }],
    messagesLoaded: true,
  })
  const carriedElsewhere = thread('t-other', { status: 'running' })
  store.setState({
    backgroundThreads: [
      { projectId: 'project-a', thread: carried },
      { projectId: 'project-b', thread: carriedElsewhere },
    ],
  })

  // The disk read is metadata-only and staler than the carried copy.
  const disk = [thread('t1', { messagesLoaded: false }), thread('t2')]
  const merged = adoptBackgroundThreads(store, 'project-a', disk)

  assert.deepEqual(
    merged.map((t) => t.id),
    ['t1', 't2'],
  )
  assert.equal(merged[0], carried)
  // Only project-a's entry is released; project-b's run stays carried.
  assert.deepEqual(store.getState().backgroundThreads, [
    { projectId: 'project-b', thread: carriedElsewhere },
  ])
})

test('adoptBackgroundThreads keeps a carried thread the disk read is missing', () => {
  const store = createStore()
  const carried = thread('t-new', { status: 'running' })
  store.setState({ backgroundThreads: [{ projectId: 'project-a', thread: carried }] })
  const merged = adoptBackgroundThreads(store, 'project-a', [thread('t1')])
  assert.deepEqual(
    merged.map((t) => t.id),
    ['t1', 't-new'],
  )
})

test('dropProjectBackgroundThreads keeps a removed project alive until its run finishes', () => {
  const store = createStore()
  store.setState({
    backgroundThreads: [
      { projectId: 'project-a', thread: thread('t-running', { status: 'running' }) },
      { projectId: 'project-a', thread: thread('t-finished') },
    ],
  })
  dropProjectBackgroundThreads(store, 'project-a')
  assert.deepEqual(
    store.getState().backgroundThreads.map((entry) => entry.thread.id),
    ['t-running'],
  )
  assert.equal(backgroundProjectOf(store, 't-running'), 'project-a')
  assert.equal(backgroundProjectOf(store, 't-finished'), undefined)
})

test('store helpers keep mutating a carried thread', () => {
  const store = createStore({ threads: [thread('t-active')], activeThreadId: 't-active' })
  store.setState({
    backgroundThreads: [{ projectId: 'project-a', thread: thread('t-bg', { status: 'running' }) }],
  })

  assert.equal(getThreadById(store, 't-bg')?.id, 't-bg')
  assert.equal(backgroundProjectOf(store, 't-bg'), 'project-a')

  const msgId = addMessage(store, 't-bg', 'assistant', '')
  appendToken(store, msgId, 'hello ')
  appendToken(store, msgId, 'world')
  setThreadTodos(store, 't-bg', [{ id: 'todo-1', content: 'step', status: 'pending' }])
  setThreadStatus(store, 't-bg', 'idle')
  markThreadUnread(store, 't-bg', 42)

  const carried = store.getState().backgroundThreads[0]?.thread
  assert.ok(carried)
  assert.equal(carried.messages[0]?.content, 'hello world')
  assert.equal(carried.todos?.length, 1)
  assert.equal(carried.status, 'idle')
  assert.equal(carried.unreadAt, 42)
  // The active project's list is untouched throughout.
  assert.deepEqual(
    store.getState().threads.map((t) => t.id),
    ['t-active'],
  )
})

// --- agent controller over a carried thread ---------------------------------

function agentSetup(carried: Thread): {
  store: AppStore
  send: (chunk: StreamChunk, threadId: string) => void
  unsub: () => void
  metas: Array<{ projectId: string; threadId: string; patch: Partial<Omit<Thread, 'messages'>> }>
  runs: string[]
} {
  const store = createStore({
    projects: [
      { id: 'project-a', path: '/a', name: 'A' },
      { id: 'project-b', path: '/b', name: 'B' },
    ],
    activeProjectId: 'project-b',
    threads: [thread('t-active')],
    activeThreadId: 't-active',
  })
  store.setState({ backgroundThreads: [{ projectId: 'project-a', thread: carried }] })

  const metas: Array<{
    projectId: string
    threadId: string
    patch: Partial<Omit<Thread, 'messages'>>
  }> = []
  const runs: string[] = []
  let chunkHandler: ((threadId: string, chunk: StreamChunk) => void) | null = null
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    agent: {
      ...base.agent,
      onChunk: (handler): (() => void) => {
        chunkHandler = handler
        return () => undefined
      },
      run: (_projectId: string, threadId: string): Promise<void> => {
        runs.push(threadId)
        return Promise.resolve()
      },
    },
    threads: {
      ...base.threads,
      updateMeta: (projectId, threadId, patch): Promise<void> => {
        metas.push({ projectId, threadId, patch })
        return Promise.resolve()
      },
    },
  }
  const unsub = startAgentController(store, api)
  return {
    store,
    send: (chunk, threadId): void => {
      chunkHandler?.(threadId, chunk)
    },
    unsub,
    metas,
    runs,
  }
}

test('chunks stream into a carried thread and done persists meta to its own project', async () => {
  const carried = thread('t-bg', { status: 'running', messagesLoaded: true })
  const { store, send, unsub, metas, runs } = agentSetup(carried)

  send({ type: 'text', text: 'finding the bug' }, 't-bg')
  send({ type: 'done', stopReason: 'end_turn' }, 't-bg')
  await new Promise((r) => setTimeout(r, 0))

  const after = store.getState().backgroundThreads[0]?.thread
  assert.ok(after)
  assert.equal(after.messages.at(-1)?.content, 'finding the bug')
  assert.equal(after.status, 'idle')

  // Final metadata lands in the carried thread's own project, not the active one.
  assert.equal(metas.length, 1)
  const meta = metas[0]
  assert.ok(meta)
  assert.equal(meta.projectId, 'project-a')
  assert.equal(meta.threadId, 't-bg')
  assert.equal(meta.patch.status, 'idle')

  // The queue is not drained from a foreign project's context.
  assert.deepEqual(runs, [])
  unsub()
})

test('a removed project keeps its carried run through done, then releases it', async () => {
  const carried = thread('t-bg', { status: 'running', messagesLoaded: true })
  const { store, send, unsub, metas } = agentSetup(carried)
  store.setState({
    projects: store.getState().projects.filter((project) => project.id !== 'project-a'),
  })
  dropProjectBackgroundThreads(store, 'project-a')

  assert.equal(backgroundProjectOf(store, 't-bg'), 'project-a')
  send({ type: 'text', text: 'last chunk after removal' }, 't-bg')
  send({ type: 'done', stopReason: 'end_turn' }, 't-bg')
  await new Promise((r) => setTimeout(r, 0))

  assert.equal(metas[0]?.projectId, 'project-a')
  assert.equal(metas[0]?.patch.status, 'idle')
  assert.deepEqual(store.getState().backgroundThreads, [])
  unsub()
})
