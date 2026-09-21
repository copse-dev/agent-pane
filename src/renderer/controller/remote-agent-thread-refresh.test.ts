import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import type { RemoteAgentLink } from '@shared/remote-agent-link.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { attachRemoteAgentThreadRefresh } from './remote-agent-thread-refresh.ts'

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

function cursorLink(agentId: string): RemoteAgentLink {
  return { provider: 'cursor', agentId, createdAt: 1 }
}

function apiWithRefresh(refreshThread: ApiClient['remoteAgent']['refreshThread']): ApiClient {
  const base = createFakeApi()
  return { ...base, remoteAgent: { ...base.remoteAgent, refreshThread } }
}

describe('attachRemoteAgentThreadRefresh', () => {
  it('refreshes the thread the app boots into, once, when it is Cursor-backed', () => {
    const calls: string[] = []
    const store = createStore({
      activeProjectId: 'proj-1',
      threads: [thread('t1', { remoteAgentLink: cursorLink('bc-1') })],
      activeThreadId: 't1',
    })
    const api = apiWithRefresh((threadId) => {
      calls.push(threadId)
      return Promise.resolve()
    })

    attachRemoteAgentThreadRefresh(store, api)

    assert.deepEqual(calls, ['t1'])
  })

  it('does not refresh a thread with no remote-agent link', () => {
    const calls: string[] = []
    const store = createStore({
      activeProjectId: 'proj-1',
      threads: [thread('t1')],
      activeThreadId: 't1',
    })
    const api = apiWithRefresh((threadId) => {
      calls.push(threadId)
      return Promise.resolve()
    })

    attachRemoteAgentThreadRefresh(store, api)
    store.emit('threads_changed')

    assert.deepEqual(calls, [])
  })

  it('does not refresh a remote-agent thread on a provider it does not cover', () => {
    const calls: string[] = []
    const store = createStore({
      activeProjectId: 'proj-1',
      threads: [
        thread('t1', {
          remoteAgentLink: { provider: 'anthropic', agentId: 'agent-1', createdAt: 1 },
        }),
      ],
      activeThreadId: 't1',
    })
    const api = apiWithRefresh((threadId) => {
      calls.push(threadId)
      return Promise.resolve()
    })

    attachRemoteAgentThreadRefresh(store, api)

    assert.deepEqual(calls, [])
  })

  it('refreshes again on switching to a different Cursor-backed thread, once each', () => {
    const calls: string[] = []
    const store = createStore({
      activeProjectId: 'proj-1',
      threads: [
        thread('t1', { remoteAgentLink: cursorLink('bc-1') }),
        thread('t2', { remoteAgentLink: cursorLink('bc-2') }),
      ],
      activeThreadId: 't1',
    })
    const api = apiWithRefresh((threadId) => {
      calls.push(threadId)
      return Promise.resolve()
    })

    attachRemoteAgentThreadRefresh(store, api)
    // Re-entrant threads_changed events for the SAME active thread (a rename,
    // a streamed chunk, ...) must not re-trigger — only an actual switch does.
    store.emit('threads_changed')
    store.emit('threads_changed')
    store.setState({ activeThreadId: 't2' })
    store.emit('threads_changed')

    assert.deepEqual(calls, ['t1', 't2'])
  })

  it('coalesces: does not start a second request while one for the same thread is in flight', async () => {
    const calls: string[] = []
    let resolveFirst: (() => void) | undefined
    const store = createStore({
      activeProjectId: 'proj-1',
      threads: [
        thread('t1', { remoteAgentLink: cursorLink('bc-1') }),
        thread('t2', { remoteAgentLink: cursorLink('bc-2') }),
      ],
      activeThreadId: 't1',
    })
    const api = apiWithRefresh((threadId) => {
      calls.push(threadId)
      if (threadId === 't1') {
        return new Promise<void>((resolve) => {
          resolveFirst = resolve
        })
      }
      return Promise.resolve()
    })

    attachRemoteAgentThreadRefresh(store, api)
    assert.deepEqual(calls, ['t1'])

    // Switch away and back to t1 before its first refresh has resolved.
    store.setState({ activeThreadId: 't2' })
    store.emit('threads_changed')
    store.setState({ activeThreadId: 't1' })
    store.emit('threads_changed')

    assert.deepEqual(calls, ['t1', 't2'], 't1 must not be requested a second time while in flight')

    resolveFirst?.()
    await Promise.resolve()
    await Promise.resolve()

    // Once the first t1 refresh has settled, reactivating it again is a fresh
    // activation and may refresh again — same for t2, which was never in
    // flight (its own call resolved immediately).
    store.setState({ activeThreadId: 't2' })
    store.emit('threads_changed')
    store.setState({ activeThreadId: 't1' })
    store.emit('threads_changed')
    assert.deepEqual(calls, ['t1', 't2', 't2', 't1'])
  })

  it('ignores a refresh rejection rather than throwing', async () => {
    const store = createStore({
      activeProjectId: 'proj-1',
      threads: [thread('t1', { remoteAgentLink: cursorLink('bc-1') })],
      activeThreadId: 't1',
    })
    const api = apiWithRefresh(() => Promise.reject(new Error('boom')))

    assert.doesNotThrow(() => {
      attachRemoteAgentThreadRefresh(store, api)
    })
    await Promise.resolve()
    await Promise.resolve()
  })

  it('detaches its listeners on cleanup', () => {
    const calls: string[] = []
    const store = createStore({
      activeProjectId: 'proj-1',
      threads: [
        thread('t1', { remoteAgentLink: cursorLink('bc-1') }),
        thread('t2', { remoteAgentLink: cursorLink('bc-2') }),
      ],
      activeThreadId: 't1',
    })
    const api = apiWithRefresh((threadId) => {
      calls.push(threadId)
      return Promise.resolve()
    })

    const detach = attachRemoteAgentThreadRefresh(store, api)
    detach()
    store.setState({ activeThreadId: 't2' })
    store.emit('threads_changed')

    assert.deepEqual(calls, ['t1'], 'no further refresh after detach')
  })
})
