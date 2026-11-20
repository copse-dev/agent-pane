import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../../../tests/setup-dom.ts'
import { createStore } from '@shared/store/store.ts'
import type { Thread, TranscriptSnapshot, Message } from '@shared/types'
import { createFakeApi } from '../fake-api.test-support.ts'
import { startAgentController } from './agent.ts'
import { attachAutosave, loadThreads, __resetPersistenceForTest } from './persistence.ts'
import { attachThreadHydration } from './thread-hydration.ts'
import { resumePendingQueues } from './message-queue.ts'
import { __resetRuntimeTranscriptForTest } from './runtime-transcript.ts'
import { TurnTranscriptWriter } from '../../main/services/turn-transcript-writer.ts'

function gate<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const copy = <T>(value: T): T => structuredClone(value)
function initial(id: string): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    messagesLoaded: false,
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...(id === 'child'
      ? {
          queuePaused: true,
          continuationUsed: 0,
          pendingMessages: [
            {
              messageId: 'persisted',
              createdAt: 1,
              payload: { content: 'Continue' },
              origin: { kind: 'machine' as const, operationId: 'subthread:parent' },
            },
          ],
        }
      : {}),
  }
}
for (const mode of [
  'idle-before-hydration',
  'idle-during-gate',
  'idle-after-hold',
  'running-before-hold',
  'running-after-hold',
  'idle-during-write-ack',
] as const) {
  test(mode, async (t) => {
    __resetPersistenceForTest()
    __resetRuntimeTranscriptForTest()
    const disk = new Map([
      ['parent', initial('parent')],
      ['child', initial('child')],
    ])
    const states: unknown[] = []
    const hydration = gate<Message[]>(),
      authorization = gate<boolean>(),
      ack = gate<undefined>()
    const readGate = gate<undefined>()
    let checks = 0,
      runs = 0,
      blockAck = false,
      snapshotHandler: ((s: TranscriptSnapshot) => void) | undefined
    let diskChain: Promise<unknown> = Promise.resolve()
    const serial = <T>(op: () => Promise<T>): Promise<T> => {
      const result = diskChain.then(op)
      diskChain = result.catch(() => undefined)
      return result
    }
    const base = createFakeApi()
    const api = {
      ...base,
      threads: {
        ...base.threads,
        loadProject: async (): Promise<Thread[]> => [...disk.values()].map(copy),
        loadMessages: async (_p: string, id: string): Promise<Message[]> =>
          id === 'child' ? hydration.promise : [],
        updateMeta: async (_p: string, id: string, patch: Partial<Thread>): Promise<void> => {
          await serial(async () => {
            const old = disk.get(id)
            assert.ok(old)
            const merged = { ...old, ...copy(patch) }
            for (const key of Object.keys(merged))
              if (Reflect.get(merged, key) === undefined) Reflect.deleteProperty(merged, key)
            disk.set(id, merged)
          })
          if (id === 'child' && blockAck) {
            blockAck = false
            await ack.promise
          }
        },
      },
      agent: {
        ...base.agent,
        onTranscriptSnapshot: (handler: (snapshot: TranscriptSnapshot) => void): (() => void) => {
          snapshotHandler = handler
          return () => {}
        },
        attachTranscripts: async (): Promise<void> => {},
        runningThreadIds: async (): Promise<string[]> => [],
        run: async (): Promise<void> => {
          runs++
        },
      },
      threadPrompts: {
        ...base.threadPrompts,
        canDispatch: async (): Promise<boolean> => {
          checks++
          return authorization.promise
        },
      },
    }
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'parent',
      threads: await loadThreads(api, 'project-1'),
    })
    const stopAgent = startAgentController(store, api)
    const autosave = attachAutosave(store, api)
    const stopHydration = attachThreadHydration(store, api)
    t.after(() => {
      stopAgent()
      stopHydration()
      autosave.detach()
    })
    const state = (label: string): void => {
      states.push({
        label,
        renderer: copy(store.getState().threads.find((t) => t.id === 'child')),
        disk: copy(disk.get('child')),
        checks,
        runs,
      })
    }
    const deliverIdle = (): void => {
      assert.ok(snapshotHandler)
      snapshotHandler({
        projectId: 'project-1',
        source: 'disk',
        thread: initial('child'),
        checkpoint: { stream: null, pendingTurn: null },
      })
    }
    const writer = new TurnTranscriptWriter({
      forward: (): void => {},
      snapshot: (s): void => {
        assert.ok(snapshotHandler)
        snapshotHandler(s)
      },
      loadThread: async (_p, id): Promise<Thread | null> =>
        serial(async () => {
          const captured = copy(disk.get(id) ?? null)
          state('attachment-read-start')
          await readGate.promise
          return captured
        }),
      appendMessage: async (): Promise<void> => {},
      updateMeta: api.threads.updateMeta,
      defaultModel: (): undefined => undefined,
      createId: (): string => 'unused',
    })
    await resumePendingQueues(store, api)
    state('hydration-pending')
    if (mode === 'idle-before-hydration') deliverIdle()
    hydration.resolve([])
    await tick()
    assert.equal(checks, 1)
    state('authorization-pending')
    if (mode === 'idle-during-gate') deliverIdle()
    let attaching: Promise<void> | undefined
    if (mode.startsWith('running-')) {
      await autosave.flush()
      assert.equal(disk.get('child')?.status, 'running')
      attaching = writer.attach('project-1', ['child'])
      await tick()
      if (mode === 'running-before-hold') {
        readGate.resolve(undefined)
        await attaching
      }
    }
    if (mode === 'idle-during-write-ack') {
      blockAck = true
      const writing = autosave.flush()
      await tick()
      state('write-committed-ack-pending')
      deliverIdle()
      authorization.resolve(false)
      await tick()
      state('held-ack-pending')
      ack.resolve(undefined)
      await writing
    } else {
      authorization.resolve(false)
      await tick()
    }
    state('held-before-late-attachment')
    if (mode === 'idle-after-hold') deliverIdle()
    if (mode === 'running-after-hold') {
      readGate.resolve(undefined)
      await attaching
    }
    await autosave.flush()
    state('first-flush')
    await autosave.flush()
    state('final')
    const final = disk.get('child')
    assert.ok(final)
    assert.equal(runs, 0)
    assert.equal(final.queuePaused, undefined)
    assert.equal(final.continuationUsed, 0)
    assert.deepEqual(
      final.pendingMessages?.map((x) => [x.messageId, x.autoDispatch]),
      [['persisted', false]],
    )
    assert.equal(final.status, 'idle', JSON.stringify(states, null, 2))
    await autosave.flush()
    assert.equal(disk.get('child')?.status, 'idle')
  })
}
