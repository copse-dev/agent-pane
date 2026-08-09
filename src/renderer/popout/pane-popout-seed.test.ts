import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types/thread.ts'
import {
  applyPopoutSeed,
  capturePopoutSeed,
  registerPopoutSeedHandlers,
} from './pane-popout-seed.ts'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

describe('pane pop-out seeds', () => {
  it('restores the source thread before applying its pane selection', async () => {
    const thread = (id: string): Thread => ({
      id,
      title: id,
      status: 'idle',
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: 1,
      updatedAt: 1,
    })
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'other',
      threads: [thread('other'), thread('source')],
    })
    let applied: unknown
    cleanups.push(
      registerPopoutSeedHandlers('changes', {
        capture: () => null,
        apply: (seed) => {
          applied = seed
        },
      }),
    )

    await applyPopoutSeed(
      'changes',
      {
        projectId: 'project-1',
        threadId: 'source',
        paneSeed: { kind: 'git', path: 'changed.ts', staged: false },
      },
      store,
    )

    assert.equal(store.getState().activeThreadId, 'source')
    assert.deepEqual(applied, { kind: 'git', path: 'changed.ts', staged: false })
  })

  it('delivers a seed after an asynchronously mounted pane registers', async () => {
    const store = createStore()
    const seed = { kind: 'git', path: 'late.ts', staged: false }

    await applyPopoutSeed('changes', seed, store)

    let applied: unknown
    cleanups.push(
      registerPopoutSeedHandlers('changes', {
        capture: () => null,
        apply: (next) => {
          applied = next
        },
      }),
    )
    await Promise.resolve()

    assert.deepEqual(applied, seed)
  })

  it('captures the pane state with its thread owner', () => {
    const store = createStore({ activeProjectId: 'project-1', activeThreadId: 'thread-1' })
    cleanups.push(
      registerPopoutSeedHandlers('explorer', {
        capture: () => ({ path: 'src/index.ts' }),
        apply: () => {},
      }),
    )

    assert.deepEqual(capturePopoutSeed('explorer', store), {
      projectId: 'project-1',
      threadId: 'thread-1',
      paneSeed: { path: 'src/index.ts' },
    })
  })
})
