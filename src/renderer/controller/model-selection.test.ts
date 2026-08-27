import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import { commitThreadModelSelection } from './model-selection.ts'

function thread(): Thread {
  return {
    id: 'thread-1',
    title: 'Model audit',
    status: 'idle',
    model: 'auto:best-value',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('commitThreadModelSelection', () => {
  it('updates immediately and records the actor-attributed selection', async () => {
    const calls: unknown[][] = []
    const base = createFakeApi()
    const selection = {
      id: 'selection-1',
      recordedAt: 10,
      by: 'user' as const,
      from: 'auto:best-value',
      to: 'claude-sonnet-4-6',
    }
    const api: ApiClient = {
      ...base,
      threads: {
        ...base.threads,
        recordModelSelection: async (...args) => {
          calls.push(args)
          return selection
        },
      },
    }
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread()],
    })

    commitThreadModelSelection(
      store,
      api,
      'thread-1',
      'user',
      'auto:best-value',
      'claude-sonnet-4-6',
    )
    assert.equal(store.getState().threads[0]?.model, 'claude-sonnet-4-6')

    await Promise.resolve()
    await Promise.resolve()

    assert.deepEqual(calls, [
      ['project-1', 'thread-1', 'user', 'auto:best-value', 'claude-sonnet-4-6'],
    ])
    assert.deepEqual(store.getState().threads[0]?.modelSelections, [selection])
  })

  it('does not record a no-op selection', () => {
    let calls = 0
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      threads: {
        ...base.threads,
        recordModelSelection: async () => {
          calls += 1
          return {
            id: 'unexpected',
            recordedAt: 10,
            by: 'user',
            to: 'auto:best-value',
          }
        },
      },
    }
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threads: [thread()],
    })

    commitThreadModelSelection(store, api, 'thread-1', 'user', 'auto:best-value', 'auto:best-value')

    assert.equal(calls, 0)
  })
})
