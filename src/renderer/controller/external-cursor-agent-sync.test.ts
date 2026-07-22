import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  mergeDiskThreadsPreferMemory,
  startExternalCursorAgentSync,
} from './external-cursor-agent-sync.ts'

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

describe('mergeDiskThreadsPreferMemory', () => {
  it('keeps in-memory copies and adds disk-only stubs, newest first', () => {
    const memory = [
      thread('live', { status: 'running', createdAt: 10, updatedAt: 10, title: 'live-mem' }),
      thread('old', { createdAt: 1, updatedAt: 1 }),
    ]
    const disk = [
      thread('live', { status: 'idle', createdAt: 10, updatedAt: 10, title: 'live-disk' }),
      thread('imported', { createdAt: 20, updatedAt: 20, title: 'Outside run' }),
      thread('old', { createdAt: 1, updatedAt: 1 }),
    ]
    const merged = mergeDiskThreadsPreferMemory(memory, disk)
    assert.deepEqual(
      merged.map((t) => t.id),
      ['imported', 'live', 'old'],
    )
    const live = merged.find((t) => t.id === 'live')
    assert.ok(live)
    assert.equal(live.title, 'live-mem')
    assert.equal(live.status, 'running')
  })
})

describe('startExternalCursorAgentSync', () => {
  it('does not sync on start; first tick is after the interval', async () => {
    const store = createStore({
      activeProjectId: 'proj-1',
      threads: [thread('existing', { updatedAt: 5 })],
      activeThreadId: 'existing',
    })
    let discoverCalls = 0
    const callbacks: Array<() => void> = []
    const api = {
      remoteAgent: {
        discoverExternal: async () => {
          discoverCalls += 1
          return {
            imported: [],
            scanned: 0,
            skippedLinked: 0,
            skippedWrongRepo: 0,
            skippedInactive: 0,
          }
        },
      },
    } as unknown as ApiClient

    const sync = startExternalCursorAgentSync(store, api, {
      intervalMs: 1_000,
      setIntervalFn: (cb) => {
        callbacks.push(cb)
        return 1
      },
      clearIntervalFn: () => undefined,
    })

    assert.equal(discoverCalls, 0)
    assert.equal(callbacks.length, 1)
    const tick = callbacks[0]
    assert.ok(tick)
    tick()
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
    assert.equal(discoverCalls, 1)
    sync.stop()
  })

  it('merges imported stubs into the open project after a successful discover', async () => {
    const store = createStore({
      activeProjectId: 'proj-1',
      threads: [
        thread('live', { status: 'running', createdAt: 10, updatedAt: 10, title: 'live-mem' }),
      ],
      activeThreadId: 'live',
    })
    let threadsChanged = 0
    store.on('threads_changed', () => {
      threadsChanged += 1
    })

    const api = {
      remoteAgent: {
        discoverExternal: async (projectId?: string) => {
          assert.equal(projectId, 'proj-1')
          return {
            imported: [
              {
                threadId: 'imported',
                agentId: 'bc-1',
                title: 'Outside',
                url: 'https://cursor.com/agents/bc-1',
              },
            ],
            scanned: 1,
            skippedLinked: 0,
            skippedWrongRepo: 0,
            skippedInactive: 0,
          }
        },
      },
    } as unknown as ApiClient

    const sync = startExternalCursorAgentSync(store, api, {
      intervalMs: 60_000,
      setIntervalFn: () => 1,
      clearIntervalFn: () => undefined,
      loadThreadsImpl: async () => [
        thread('live', { status: 'idle', createdAt: 10, updatedAt: 10, title: 'live-disk' }),
        thread('imported', { createdAt: 20, updatedAt: 20, title: 'Outside' }),
      ],
    })

    await sync.syncNow()
    const ids = store.getState().threads.map((t) => t.id)
    assert.deepEqual(ids, ['imported', 'live'])
    const live = store.getState().threads.find((t) => t.id === 'live')
    assert.ok(live)
    assert.equal(live.status, 'running')
    assert.equal(live.title, 'live-mem')
    assert.equal(threadsChanged, 1)
    sync.stop()
  })

  it('skips when no project is open and ignores discover failures', async () => {
    const store = createStore({ activeProjectId: null, threads: [] })
    let discoverCalls = 0
    const api = {
      remoteAgent: {
        discoverExternal: async () => {
          discoverCalls += 1
          throw new Error('no key')
        },
      },
    } as unknown as ApiClient

    const sync = startExternalCursorAgentSync(store, api, {
      setIntervalFn: () => 1,
      clearIntervalFn: () => undefined,
    })
    await sync.syncNow()
    assert.equal(discoverCalls, 0)

    store.setState({ activeProjectId: 'proj-1' })
    await sync.syncNow()
    assert.equal(discoverCalls, 1)
    assert.equal(store.getState().threads.length, 0)
    sync.stop()
  })
})
