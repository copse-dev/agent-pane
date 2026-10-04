import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createStore } from '@shared/store/store.ts'
import { createThread, getActiveThread } from '@shared/store/thread-helpers.ts'
import type {
  ModelInvalidation,
  ModelInvalidationReport,
  ModelSavedChoice,
  ModelSettingsTarget,
} from '@shared/model-invalidation.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import {
  checkProviderInvalidation,
  attachProviderInvalidationWarning,
} from './provider-invalidation.ts'

function report(
  invalidations: ModelInvalidation[],
  selections: ModelSavedChoice[] = invalidations.map(({ target, model }) => ({ target, model })),
  verifiedChoices: ModelSavedChoice[] = [],
): ModelInvalidationReport {
  return { evaluated: true, invalidations, selections, verifiedChoices }
}

function fixture(): {
  store: ReturnType<typeof createStore>
  id: string
  api: ApiClient
  ui: { warn: () => Promise<boolean>; openSettings: (target: ModelSettingsTarget) => void }
  opened: ModelSettingsTarget[]
  recovered: string[]
  warnings: () => number
} {
  const store = createStore({ activeProjectId: 'project' })
  const id = createThread(store)
  store.setState({
    threads: store.getState().threads.map((thread) => ({ ...thread, model: 'removed:model' })),
  })
  const base = createFakeApi()
  const recovered: string[] = []
  const api: ApiClient = {
    ...base,
    models: {
      ...base.models,
      invalidations: async (model): Promise<ModelInvalidationReport> =>
        report(
          model?.startsWith('removed:')
            ? [
                {
                  target: 'thread',
                  label: 'This chat',
                  model,
                  reason: 'Provider removed.',
                  fallback: 'lmstudio:qwen/qwen3.6-35b-a3b',
                },
              ]
            : [],
          model ? [{ target: 'thread', model }] : [],
        ),
      recoverSetting: async (target): Promise<boolean> => {
        recovered.push(target)
        return true
      },
    },
  }
  let warnings = 0
  const opened: ModelSettingsTarget[] = []
  const ui = {
    warn: async (): Promise<boolean> => {
      warnings++
      return false
    },
    openSettings: (target: ModelSettingsTarget): void => {
      opened.push(target)
    },
  }
  return { store, id, api, ui, opened, recovered, warnings: () => warnings }
}
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15))

describe('provider settings recovery', () => {
  it('dismissal repairs the exact active thread with attributed selection', async () => {
    const f = fixture()
    assert.equal((await checkProviderInvalidation(f.store, f.api, f.ui)).length, 1)
    assert.equal(getActiveThread(f.store)?.model, 'lmstudio:qwen/qwen3.6-35b-a3b')
    assert.equal(f.warnings(), 1)
  })
  it('reveals the field for the first invalid saved role', async () => {
    const f = fixture()
    f.api.models.invalidations = async (): Promise<ModelInvalidationReport> =>
      report([
        {
          target: 'role:research',
          label: 'Research',
          model: 'removed:model',
          reason: 'Provider removed.',
        },
      ])
    await checkProviderInvalidation(f.store, f.api, { ...f.ui, warn: async () => true })
    assert.deepEqual(f.opened, ['subagentModel'])
    assert.equal(getActiveThread(f.store)?.model, 'removed:model')
  })
  it('warns for persisted settings without any chat and recovers all eligible fields', async () => {
    const f = fixture()
    f.store.setState({ activeThreadId: null, settings: { model: 'removed:default' } })
    f.api.models.invalidations = async (): Promise<ModelInvalidationReport> =>
      report([
        {
          target: 'model',
          label: 'Chat default',
          model: 'removed:default',
          reason: 'Provider removed.',
          fallback: 'lmstudio:qwen/qwen3.6-35b-a3b',
        },
        {
          target: 'role:research',
          label: 'Research',
          model: 'openrouter:old',
          reason: 'No key.',
          fallback: 'lmstudio:qwen/qwen3.6-35b-a3b',
        },
        { target: 'safetyModel', label: 'Safety', model: 'old', reason: 'Not available.' },
      ])
    await checkProviderInvalidation(f.store, f.api, f.ui)
    assert.deepEqual(f.recovered, ['model', 'role:research'])
    assert.equal(f.store.getState().settings?.model, 'lmstudio:qwen/qwen3.6-35b-a3b')
    assert.equal(f.warnings(), 1)
  })
  it('keeps fields whose main-process compare or revalidation declines recovery', async () => {
    const f = fixture()
    f.store.setState({ settings: { model: 'removed:default' } })
    f.api.models.invalidations = async (): Promise<ModelInvalidationReport> =>
      report([
        {
          target: 'model',
          label: 'Chat default',
          model: 'removed:default',
          reason: 'No key.',
          fallback: 'lmstudio:qwen/qwen3.6-35b-a3b',
        },
      ])
    f.api.models.recoverSetting = async (): Promise<boolean> => false
    await checkProviderInvalidation(f.store, f.api, f.ui)
    assert.equal(f.store.getState().settings?.model, 'removed:default')
  })
  it('never interprets a failed query as invalid settings', async () => {
    const f = fixture()
    f.api.models.invalidations = async (): Promise<ModelInvalidationReport> => {
      throw new Error('offline')
    }
    await checkProviderInvalidation(f.store, f.api, f.ui)
    assert.equal(f.warnings(), 0)
  })
  it('revalidates thread fallback after dismissal', async () => {
    const f = fixture()
    await checkProviderInvalidation(f.store, f.api, {
      ...f.ui,
      warn: async (): Promise<boolean> => {
        f.api.models.invalidations = async (): Promise<ModelInvalidationReport> => report([])
        return false
      },
    })
    assert.equal(getActiveThread(f.store)?.model, 'removed:model')
  })
  it('does not overwrite a later user choice or disposed owner', async () => {
    for (const change of ['selection', 'dispose']) {
      const f = fixture()
      let active = true
      await checkProviderInvalidation(f.store, f.api, {
        ...f.ui,
        isActive: () => active,
        warn: async (): Promise<boolean> => {
          if (change === 'selection')
            f.store.setState({
              threads: f.store
                .getState()
                .threads.map((thread) => ({ ...thread, model: 'user:choice' })),
            })
          else active = false
          return false
        },
      })
      assert.equal(
        getActiveThread(f.store)?.model,
        change === 'selection' ? 'user:choice' : 'removed:model',
      )
    }
  })
})

describe('provider warning ownership', () => {
  it('coalesces a thread switch during an in-flight query', async () => {
    const f = fixture()
    let release: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = f.api.models.invalidations
    let calls = 0
    f.api.models.invalidations = async (model): Promise<ModelInvalidationReport> => {
      if (++calls === 1) await pending
      return original(model)
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
    await tick()
    assert.equal(f.warnings(), 1)
    assert.equal(getActiveThread(f.store)?.model, 'lmstudio:qwen/qwen3.6-35b-a3b')
    stop()
  })
  it('acknowledges unchanged fields once but warns each distinct thread', async () => {
    const f = fixture()
    f.api.models.invalidations = async (model): Promise<ModelInvalidationReport> =>
      report(
        model?.startsWith('removed:')
          ? [{ target: 'thread', label: 'This chat', model, reason: 'Removed.' }]
          : [],
        model ? [{ target: 'thread', model }] : [],
      )
    const stop = attachProviderInvalidationWarning(f.store, f.api, f.ui)
    await tick()
    f.store.emit('threads_changed')
    f.store.emit('settings_changed')
    await tick()
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
    await tick()
    assert.equal(f.warnings(), 2)
    stop()
  })
  it('re-arms a saved-field warning only after verified recovery, preserving acknowledgement on probe errors', async () => {
    const f = fixture()
    let available = false
    let failed = false
    f.api.models.invalidations = async (): Promise<ModelInvalidationReport> => {
      if (failed) throw new Error('Unavailable')
      const choice: ModelSavedChoice = { target: 'model', model: 'removed:model' }
      return report(
        available ? [] : [{ ...choice, label: 'Default', reason: 'Removed.' }],
        [choice],
        available ? [choice] : [],
      )
    }
    const stop = attachProviderInvalidationWarning(f.store, f.api, f.ui)
    await tick()
    assert.equal(f.warnings(), 1)
    failed = true
    f.store.emit('settings_changed')
    await tick()
    failed = false
    f.store.emit('settings_changed')
    await tick()
    assert.equal(f.warnings(), 1)
    available = true
    f.store.emit('settings_changed')
    await tick()
    available = false
    f.store.emit('settings_changed')
    await tick()
    assert.equal(f.warnings(), 2)
    stop()
  })
  it('does not reopen a default warning when startup creates an unedited chat from that default', async () => {
    const f = fixture()
    f.store.setState({
      threads: [],
      activeThreadId: null,
      settings: { model: 'removed:model' },
    })
    f.api.models.invalidations = async (model): Promise<ModelInvalidationReport> =>
      report([
        ...(model ? [{ target: 'thread' as const, label: 'Chat', model, reason: 'Removed.' }] : []),
        { target: 'model', label: 'Default', model: 'removed:model', reason: 'Removed.' },
      ])
    const stop = attachProviderInvalidationWarning(f.store, f.api, f.ui)
    await tick()
    assert.equal(f.warnings(), 1)
    createThread(f.store)
    f.store.emit('settings_changed')
    await tick()
    assert.equal(f.warnings(), 1)
    stop()
  })
  it('retains a thread acknowledgement while a running thread is not probed', async () => {
    const f = fixture()
    f.api.models.invalidations = async (model): Promise<ModelInvalidationReport> =>
      report(
        model ? [{ target: 'thread', label: 'Chat', model, reason: 'Removed.' }] : [],
        model ? [{ target: 'thread', model }] : [],
      )
    const stop = attachProviderInvalidationWarning(f.store, f.api, f.ui)
    await tick()
    assert.equal(f.warnings(), 1)
    f.store.setState({
      threads: f.store.getState().threads.map((thread) => ({ ...thread, status: 'running' })),
    })
    f.store.emit('thread_status_changed', f.id, 'running')
    await tick()
    f.store.setState({
      threads: f.store.getState().threads.map((thread) => ({ ...thread, status: 'idle' })),
    })
    f.store.emit('thread_status_changed', f.id, 'idle')
    await tick()
    assert.equal(f.warnings(), 1)
    stop()
  })
  it('does not mistake unknown provider evidence for a repaired saved choice', async () => {
    const f = fixture()
    let unknown = false
    const choice: ModelSavedChoice = { target: 'model', model: 'removed:model' }
    f.api.models.invalidations = async (): Promise<ModelInvalidationReport> =>
      report(unknown ? [] : [{ ...choice, label: 'Default', reason: 'Removed.' }], [choice])
    const stop = attachProviderInvalidationWarning(f.store, f.api, f.ui)
    await tick()
    unknown = true
    f.store.emit('settings_changed')
    await tick()
    unknown = false
    f.store.emit('settings_changed')
    await tick()
    assert.equal(f.warnings(), 1)
    stop()
  })
})
