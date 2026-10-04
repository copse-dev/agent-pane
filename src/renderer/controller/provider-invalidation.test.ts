import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createStore } from '@shared/store/store.ts'
import { createThread, getActiveThread } from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import {
  checkProviderInvalidation,
  attachProviderInvalidationWarning,
} from './provider-invalidation.ts'

function fixture(): {
  store: ReturnType<typeof createStore>
  id: string
  api: ApiClient
  ui: { warn: () => Promise<boolean>; openSettings: () => void }
  opened: () => boolean
  warnings: () => number
} {
  const store = createStore({ activeProjectId: 'project' })
  const id = createThread(store)
  store.setState({
    threads: store.getState().threads.map((thread) => ({ ...thread, model: 'removed:model' })),
  })
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    settings: { ...base.settings, extraProviders: async () => [] },
    lmStudio: {
      ...base.lmStudio,
      modelInfo: async () => [{ id: 'qwen/qwen3.6-35b-a3b', local: true }],
    },
  }
  let opened = false
  let warnings = 0
  const ui = {
    warn: async (): Promise<boolean> => {
      warnings++
      return false
    },
    openSettings: (): void => {
      opened = true
    },
  }
  return { store, id, api, ui, opened: (): boolean => opened, warnings: (): number => warnings }
}

describe('removed provider recovery', () => {
  it('dismissal switches the exact invalid thread to a reachable local coding model', async () => {
    const f = fixture()
    assert.equal(await checkProviderInvalidation(f.store, f.api, f.ui), 'removed:model')
    assert.equal(getActiveThread(f.store)?.model, 'lmstudio:qwen/qwen3.6-35b-a3b')
    assert.equal(f.warnings(), 1)
  })
  it('opens the relevant Settings surface without changing the model', async () => {
    const f = fixture()
    await checkProviderInvalidation(f.store, f.api, { ...f.ui, warn: async () => true })
    assert.equal(f.opened(), true)
    assert.equal(getActiveThread(f.store)?.model, 'removed:model')
  })
  it('does not replace the model when only embedding or unknown-capability models exist', async () => {
    const f = fixture()
    f.api.lmStudio.modelInfo = async (): ReturnType<ApiClient['lmStudio']['modelInfo']> => [
      { id: 'qwen/qwen3.6-35b-a3b', embedding: true },
      { id: 'unknown' },
    ]
    await checkProviderInvalidation(f.store, f.api, f.ui)
    assert.equal(getActiveThread(f.store)?.model, 'removed:model')
  })
  it('does not infer removal from a provider-list failure', async () => {
    const f = fixture()
    f.api.settings.extraProviders = async (): ReturnType<
      ApiClient['settings']['extraProviders']
    > => {
      throw new Error('offline')
    }
    await checkProviderInvalidation(f.store, f.api, f.ui)
    assert.equal(f.warnings(), 0)
  })
  it('does not use a remote server or a legacy row with unknown locality as a local fallback', async () => {
    for (const local of [false, undefined]) {
      const f = fixture()
      f.api.lmStudio.modelInfo = async (): ReturnType<ApiClient['lmStudio']['modelInfo']> => [
        { id: 'qwen/qwen3.6-35b-a3b', ...(local !== undefined ? { local } : {}) },
      ]
      await checkProviderInvalidation(f.store, f.api, f.ui)
      assert.equal(getActiveThread(f.store)?.model, 'removed:model')
    }
  })
  it('rechecks locality when the user dismisses the warning', async () => {
    const f = fixture()
    await checkProviderInvalidation(f.store, f.api, {
      ...f.ui,
      warn: async (): Promise<boolean> => {
        f.api.lmStudio.modelInfo = async (): ReturnType<ApiClient['lmStudio']['modelInfo']> => [
          { id: 'qwen/qwen3.6-35b-a3b', local: false },
        ]
        return false
      },
    })
    assert.equal(getActiveThread(f.store)?.model, 'removed:model')
  })
  it('never overwrites a user model choice while the warning is open', async () => {
    const f = fixture()
    await checkProviderInvalidation(f.store, f.api, {
      ...f.ui,
      warn: async (): Promise<boolean> => {
        f.store.setState({
          threads: f.store
            .getState()
            .threads.map((thread) => ({ ...thread, model: 'user:choice' })),
        })
        return false
      },
    })
    assert.equal(getActiveThread(f.store)?.model, 'user:choice')
  })
  it('rechecks local availability after dismissal', async () => {
    const f = fixture()
    await checkProviderInvalidation(f.store, f.api, {
      ...f.ui,
      warn: async (): Promise<boolean> => {
        f.api.lmStudio.modelInfo = async (): ReturnType<ApiClient['lmStudio']['modelInfo']> => []
        return false
      },
    })
    assert.equal(getActiveThread(f.store)?.model, 'removed:model')
  })
  it('does not intervene in a non-custom route', async () => {
    const f = fixture()
    f.store.setState({
      threads: f.store
        .getState()
        .threads.map((thread) => ({ ...thread, model: 'lmstudio:missing' })),
    })
    await checkProviderInvalidation(f.store, f.api, f.ui)
    assert.equal(f.warnings(), 0)
  })
  it('does not replace a model once its owner has disposed the warning', async () => {
    const f = fixture()
    let active = true
    await checkProviderInvalidation(f.store, f.api, {
      ...f.ui,
      isActive: () => active,
      warn: async (): Promise<boolean> => {
        active = false
        return false
      },
    })
    assert.equal(getActiveThread(f.store)?.model, 'removed:model')
  })
})

describe('provider warning subscriptions', () => {
  it('coalesces a thread switch during an in-flight probe and warns the new thread', async () => {
    const f = fixture()
    let release: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    let probes = 0
    f.api.settings.extraProviders = async (): ReturnType<
      ApiClient['settings']['extraProviders']
    > => {
      if (++probes === 1) await waiting
      return []
    }
    const stop = attachProviderInvalidationWarning(f.store, f.api, f.ui)
    const next = createThread(f.store)
    f.store.setState({
      threads: f.store
        .getState()
        .threads.map((thread) =>
          thread.id === next ? { ...thread, model: 'removed:second' } : thread,
        ),
    })
    f.store.emit('threads_changed')
    release?.()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(f.warnings(), 1)
    assert.equal(getActiveThread(f.store)?.model, 'lmstudio:qwen/qwen3.6-35b-a3b')
    stop()
  })
  it('acknowledges each thread separately and does not repeatedly warn one thread', async () => {
    const f = fixture()
    f.api.lmStudio.modelInfo = async (): ReturnType<ApiClient['lmStudio']['modelInfo']> => []
    const stop = attachProviderInvalidationWarning(f.store, f.api, f.ui)
    await new Promise((resolve) => setTimeout(resolve, 10))
    f.store.emit('threads_changed')
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(f.warnings(), 1)
    const next = createThread(f.store)
    f.store.setState({
      threads: f.store
        .getState()
        .threads.map((thread) =>
          thread.id === next ? { ...thread, model: 'removed:model' } : thread,
        ),
    })
    f.store.emit('threads_changed')
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(f.warnings(), 2)
    stop()
  })
})
