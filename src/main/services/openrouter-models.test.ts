import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseOpenRouterModelsPayload,
  listFreeOpenRouterModels,
  openRouterModelContextLength,
  invalidateOpenRouterModelsCache,
} from './openrouter-models.ts'

const SAMPLE = {
  data: [
    {
      id: 'qwen/qwen3-235b-a22b:free',
      name: 'Qwen3 235B A22B (free)',
      context_length: 262144,
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: ['tools', 'temperature'],
      architecture: { modality: 'text->text', output_modalities: ['text'] },
    },
    {
      id: 'z-ai/glm-4.5-air:free',
      name: 'GLM 4.5 Air (free)',
      context_length: 131072,
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: ['temperature'], // free but no tool support
      architecture: { modality: 'text->text' },
    },
    {
      id: 'anthropic/claude-3.5-sonnet',
      name: 'Claude 3.5 Sonnet',
      context_length: 200000,
      pricing: { prompt: '0.000003', completion: '0.000015' }, // paid
      supported_parameters: ['tools'],
      architecture: { modality: 'text->text' },
    },
    {
      id: 'bytedance/seedance-2.0',
      name: 'Seedance 2.0',
      context_length: 0,
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: [],
      architecture: { modality: 'text->video', output_modalities: ['video'] }, // not text output
    },
  ],
}

function stubFetch(json: unknown): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async (): Promise<unknown> => json,
  })) as unknown as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

describe('parseOpenRouterModelsPayload', () => {
  it('keeps text models and drops non-text generators', () => {
    const models = parseOpenRouterModelsPayload(SAMPLE)
    const ids = models.map((m) => m.id)
    assert.ok(!ids.includes('bytedance/seedance-2.0'), 'video model should be dropped')
    assert.equal(models.length, 3)
  })

  it('flags free pricing and tool support', () => {
    const models = parseOpenRouterModelsPayload(SAMPLE)
    const qwen = models.find((m) => m.id === 'qwen/qwen3-235b-a22b:free')!
    assert.equal(qwen.free, true)
    assert.equal(qwen.supportsTools, true)
    assert.equal(qwen.contextLength, 262144)

    const claude = models.find((m) => m.id === 'anthropic/claude-3.5-sonnet')!
    assert.equal(claude.free, false)
  })
})

describe('listFreeOpenRouterModels', () => {
  let restore: (() => void) | undefined
  afterEach(() => {
    restore?.()
    restore = undefined
    invalidateOpenRouterModelsCache()
  })

  it('returns only free, tool-capable models', async () => {
    invalidateOpenRouterModelsCache()
    restore = stubFetch(SAMPLE)
    const models = await listFreeOpenRouterModels()
    assert.deepEqual(
      models.map((m) => m.id),
      ['qwen/qwen3-235b-a22b:free'],
    )
  })

  it('exposes context length from the cached catalog', async () => {
    invalidateOpenRouterModelsCache()
    restore = stubFetch(SAMPLE)
    const ctx = await openRouterModelContextLength('anthropic/claude-3.5-sonnet')
    assert.equal(ctx, 200000)
  })
})
