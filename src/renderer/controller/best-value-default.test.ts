import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { createThread, getActiveThread } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  attachBestValueDefaultResolver,
  resolveBestValueForActiveBlankThread,
} from './best-value-default.ts'

function mockApi(resolved = 'claude-sonnet-4-6'): {
  models: Pick<ApiClient['models'], 'bestValueDefault'>
} {
  return {
    models: {
      bestValueDefault: async () => resolved,
    },
  }
}

describe('resolveBestValueForActiveBlankThread', () => {
  it('replaces the best-value sentinel on a blank thread with the concrete route', async () => {
    const store = createStore()
    store.setState({ settings: { model: 'auto:best-value' } })
    createThread(store)
    assert.equal(getActiveThread(store)?.model, 'auto:best-value')

    await resolveBestValueForActiveBlankThread(store, mockApi('claude-opus-4-8'))
    assert.equal(getActiveThread(store)?.model, 'claude-opus-4-8')
  })

  it('leaves a pinned concrete model alone', async () => {
    const store = createStore()
    store.setState({ settings: { model: 'gpt-4o' } })
    createThread(store)
    await resolveBestValueForActiveBlankThread(store, mockApi('claude-opus-4-8'))
    assert.equal(getActiveThread(store)?.model, 'gpt-4o')
  })

  it('resolves a persisted blank thread as soon as its workspace loads', async () => {
    const store = createStore()
    store.setState({ settings: { model: 'auto:best-value' } })
    createThread(store)
    const unsubscribe = attachBestValueDefaultResolver(store, mockApi('claude-opus-4-8'))

    store.emit('workspace_changed')
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(getActiveThread(store)?.model, 'claude-opus-4-8')
    unsubscribe()
  })
})
