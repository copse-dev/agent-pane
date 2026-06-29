import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { importDetectedPreset, type LocalServerResult } from './local-detection.ts'
import {
  getResolvedExtraProviders,
  getResolvedExtraProvider,
  saveExtraProvider,
} from '../../../main/services/extra-providers-store.ts'
import { setSetting } from '../../../main/services/settings.ts'

// A minimal ApiClient stand-in whose extra-provider methods delegate to the real
// main-process store. This exercises the actual read-modify-write of the single
// `extraProviders` setting that importDetectedPreset relies on — the surface the
// concurrency bug lived on.
function fakeApi() {
  return {
    settings: {
      extraProviders: async () => getResolvedExtraProviders(),
      saveExtraProvider: async (record: Parameters<typeof saveExtraProvider>[0]) =>
        saveExtraProvider(record),
    },
    // importDetectedPreset only touches api.settings; cast covers the rest.
  } as unknown as Parameters<typeof importDetectedPreset>[0]
}

const reachable = (id: string, models: string[]): LocalServerResult => ({
  id,
  label: id,
  baseUrl: `http://localhost/${id}`,
  reachable: true,
  models,
})

describe('importDetectedPreset', () => {
  beforeEach(async () => {
    await setSetting('extraProviders', [])
  })

  it('persists probed models for a reachable preset', async () => {
    await importDetectedPreset(fakeApi(), reachable('ollama', ['llama3', 'qwen2']))
    assert.deepEqual(
      getResolvedExtraProvider('ollama')?.models.map((m) => m.id),
      ['llama3', 'qwen2'],
    )
  })

  it('skips lmstudio, unreachable, and empty-model results', async () => {
    const api = fakeApi()
    await importDetectedPreset(api, { ...reachable('lmstudio', ['x']), id: 'lmstudio' })
    await importDetectedPreset(api, { ...reachable('ollama', ['x']), reachable: false })
    await importDetectedPreset(api, reachable('vllm', []))
    // Nothing stored: every provider stays at its shipped (empty) model list.
    assert.equal(getResolvedExtraProvider('ollama')?.models.length, 0)
    assert.equal(getResolvedExtraProvider('vllm')?.models.length, 0)
  })

  it('merges with a curated model list instead of replacing it', async () => {
    // User curated a model with a custom label.
    await saveExtraProvider({ slug: 'ollama', models: [{ id: 'my-model', label: 'My Model' }] })
    // A re-scan finds the curated id plus a new one.
    await importDetectedPreset(fakeApi(), reachable('ollama', ['my-model', 'fresh-model']))
    const models = getResolvedExtraProvider('ollama')?.models ?? []
    // Curated entry preserved with its label; new id appended; no duplicate.
    assert.deepEqual(models, [
      { id: 'my-model', label: 'My Model' },
      { id: 'fresh-model' },
    ])
  })

  it('imports every reachable preset when run sequentially (no lost-update)', async () => {
    const results = [
      reachable('ollama', ['a']),
      reachable('llamacpp', ['b']),
      reachable('jan', ['c']),
      reachable('vllm', ['d']),
    ]
    // The onboarding loop runs these sequentially; doing so must not drop any.
    for (const r of results) await importDetectedPreset(fakeApi(), r)
    assert.deepEqual(getResolvedExtraProvider('ollama')?.models.map((m) => m.id), ['a'])
    assert.deepEqual(getResolvedExtraProvider('llamacpp')?.models.map((m) => m.id), ['b'])
    assert.deepEqual(getResolvedExtraProvider('jan')?.models.map((m) => m.id), ['c'])
    assert.deepEqual(getResolvedExtraProvider('vllm')?.models.map((m) => m.id), ['d'])
  })
})
