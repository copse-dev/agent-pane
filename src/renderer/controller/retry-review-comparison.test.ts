import { test } from 'node:test'
import assert from 'node:assert/strict'
import { retryReview, retryComparison } from './retry-review-comparison.ts'
import { createStore } from '@shared/store/store.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

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

interface RetryCalls {
  review: unknown[][]
  comparison: unknown[][]
}

function setup(activeProjectId: string | null): {
  store: AppStore
  api: ApiClient
  calls: RetryCalls
} {
  const store = createStore({
    activeProjectId,
    activeThreadId: 't1',
    threads: [thread('t1')],
  })
  const calls: RetryCalls = { review: [], comparison: [] }
  const api = ((): ApiClient => {
    const base = createFakeApi()
    return {
      ...base,
      agent: {
        ...base['agent'],
        retryReview: (...args: unknown[]): Promise<void> => {
          calls.review.push(args)
          return Promise.resolve()
        },
        retryComparison: (...args: unknown[]): Promise<void> => {
          calls.comparison.push(args)
          return Promise.resolve()
        },
      },
    } satisfies ApiClient
  })()
  return { store, api, calls }
}

// The main-process retry handlers resolve a ThreadExecutionContext from
// projectId + threadId; without it the review subagent's staged-diff tools throw
// "No thread execution context is active". The renderer must therefore send the
// active projectId first, matching `agent:run`.
test('retryReview sends the active projectId ahead of the threadId', () => {
  const { store, api, calls } = setup('project-1')
  retryReview(store, api, 't1', 'm1')
  assert.equal(calls.review.length, 1)
  const [call] = calls.review
  assert.ok(call)
  assert.equal(call[0], 'project-1')
  assert.equal(call[1], 't1')
})

test('retryComparison sends the active projectId ahead of the threadId', () => {
  const { store, api, calls } = setup('project-1')
  retryComparison(store, api, 't1')
  assert.equal(calls.comparison.length, 1)
  const [call] = calls.comparison
  assert.ok(call)
  assert.equal(call[0], 'project-1')
  assert.equal(call[1], 't1')
})

test('retry actions no-op when no project is active rather than send an unresolvable request', () => {
  const { store, api, calls } = setup(null)
  retryReview(store, api, 't1', 'm1')
  retryComparison(store, api, 't1')
  assert.equal(calls.review.length, 0)
  assert.equal(calls.comparison.length, 0)
})
