import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Message, Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import {
  attachImportedCursorAgentRefresh,
  mergeImportedCursorResult,
} from './imported-cursor-agent-refresh.ts'

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

function imported(id: string, overrides: Partial<Thread> = {}): Thread {
  return thread(id, {
    remoteAgentLink: {
      provider: 'cursor',
      agentId: 'agent-1',
      runId: 'run-1',
      imported: true,
      createdAt: 1,
    },
    ...overrides,
  })
}

function apiWithRefresh(
  refreshImportedThread: ApiClient['remoteAgent']['refreshImportedThread'],
): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    remoteAgent: { ...base.remoteAgent, refreshImportedThread },
  }
}

const result: Message = {
  id: 'remote-cursor-run-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  role: 'assistant',
  content: 'Finished the cloud task.',
  toolCalls: [],
  createdAt: 10,
}

const inMemoryTail: Message = {
  id: 'live-tail',
  role: 'assistant',
  content: 'A local in-memory tail.',
  toolCalls: [],
  createdAt: 5,
}

describe('imported Cursor agent refresh', () => {
  it('merges a selected imported thread result exactly once', async () => {
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'external',
      threads: [imported('external')],
    })
    const calls: Array<{ projectId: string; threadId: string }> = []
    const detach = attachImportedCursorAgentRefresh(
      store,
      apiWithRefresh(async (projectId, threadId) => {
        calls.push({ projectId, threadId })
        return result
      }),
    )

    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    assert.deepEqual(calls, [{ projectId: 'project-1', threadId: 'external' }])
    assert.deepEqual(store.getState().threads[0]?.messages, [result])
    detach()
  })

  it('does not request a running local turn or a non-imported Cursor thread', async () => {
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'running',
      threads: [imported('running', { status: 'running' })],
    })
    let calls = 0
    const detach = attachImportedCursorAgentRefresh(
      store,
      apiWithRefresh(async () => {
        calls += 1
        return result
      }),
    )

    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.equal(calls, 0)

    store.setState({
      activeThreadId: 'local',
      threads: [
        thread('local', {
          remoteAgentLink: { provider: 'cursor', agentId: 'agent-2', runId: 'run-2', createdAt: 1 },
        }),
      ],
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.equal(calls, 0)
    detach()
  })

  it('discards a result after the user selects another thread', async () => {
    let resolveResult: ((message: Message | null) => void) | undefined
    const pending = new Promise<Message | null>((resolve) => {
      resolveResult = resolve
    })
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'external',
      threads: [imported('external'), thread('other')],
    })
    const detach = attachImportedCursorAgentRefresh(
      store,
      apiWithRefresh(async () => pending),
    )

    store.setState({ activeThreadId: 'other' })
    resolveResult?.(result)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    const original = store.getState().threads.find((candidate) => candidate.id === 'external')
    assert.ok(original)
    assert.equal(original.messages.length, 0)
    detach()
  })

  it('discards a result after the active project changes', async () => {
    let resolveResult: ((message: Message | null) => void) | undefined
    const pending = new Promise<Message | null>((resolve) => {
      resolveResult = resolve
    })
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'external',
      threads: [imported('external')],
    })
    const detach = attachImportedCursorAgentRefresh(
      store,
      apiWithRefresh(async () => pending),
    )

    store.setState({ activeProjectId: 'project-2', activeThreadId: null, threads: [] })
    resolveResult?.(result)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    assert.equal(store.getState().threads.length, 0)
    detach()
  })

  it('discards a result after a newer imported run replaces the link', async () => {
    let resolveResult: ((message: Message | null) => void) | undefined
    const pending = new Promise<Message | null>((resolve) => {
      resolveResult = resolve
    })
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'external',
      threads: [imported('external')],
    })
    let calls = 0
    const detach = attachImportedCursorAgentRefresh(
      store,
      apiWithRefresh(async () => {
        calls += 1
        return calls === 1 ? pending : new Promise(() => {})
      }),
    )

    store.setState({
      threads: [
        imported('external', {
          remoteAgentLink: {
            provider: 'cursor',
            agentId: 'agent-1',
            runId: 'run-2',
            imported: true,
            createdAt: 2,
          },
        }),
      ],
    })
    resolveResult?.(result)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    assert.equal(store.getState().threads[0]?.messages.length, 0)
    detach()
  })

  it('requests a newly selected imported thread from setState alone, but not on renames', async () => {
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'local',
      threads: [thread('local'), imported('external', { status: 'running' })],
    })
    const calls: string[] = []
    const detach = attachImportedCursorAgentRefresh(
      store,
      apiWithRefresh(async (_projectId, threadId) => {
        calls.push(threadId)
        return null
      }),
    )
    store.setState({ activeThreadId: 'external' })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(calls, [], 'a running imported thread is not requested')

    // Its turn ends: the selected thread now qualifies, with no event emitted.
    store.setState({
      threads: store
        .getState()
        .threads.map((t) => (t.id === 'external' ? { ...t, status: 'idle' } : t)),
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(calls, ['external'])

    // A rename of this thread, or any change to another, does not re-request.
    store.setState({
      threads: store
        .getState()
        .threads.map((t) => ({ ...t, title: `${t.title} (renamed)`, updatedAt: 2 })),
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(calls, ['external'])
    detach()
  })

  it('does not duplicate an already merged terminal message', () => {
    const current = imported('external', { messages: [result] })
    assert.equal(mergeImportedCursorResult(current, result), current)
  })

  it('preserves an in-memory tail when the main process returns a refresh result', () => {
    const current = imported('external', { messages: [inMemoryTail] })
    assert.deepEqual(mergeImportedCursorResult(current, result).messages, [inMemoryTail, result])
  })

  it('does not refresh a selected imported stub with queued local work', async () => {
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'external',
      threads: [
        imported('external', {
          pendingMessages: [
            {
              messageId: 'queued-user',
              payload: { content: 'Continue locally.' },
              createdAt: 2,
            },
          ],
          queuePaused: true,
        }),
      ],
    })
    let calls = 0
    const detach = attachImportedCursorAgentRefresh(
      store,
      apiWithRefresh(async () => {
        calls += 1
        return result
      }),
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.equal(calls, 0)
    detach()
  })
})
