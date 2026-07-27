import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { setSetting } from '../storage/settings.ts'
import {
  parseOpenRouterModelsPayload,
  listFreeOpenRouterModels,
  openRouterModelContextLength,
  invalidateOpenRouterModelsCache,
  filterToZdrModels,
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

// ZDR endpoints payload (the /endpoints/zdr shape): display model_name rows.
const ZDR_SAMPLE = {
  data: [
    { name: 'Novita | qwen3-235b', model_name: 'Qwen3 235B A22B (free)', provider_name: 'Novita' },
  ],
}

// Stub fetch, routing the ZDR endpoint list and the models catalog separately
// so tests control each payload (both live under the same API base).
function stubFetch(modelsJson: unknown, zdrJson: unknown = { data: [] }): () => void {
  const original = globalThis.fetch
  globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const json = url.includes('/endpoints/zdr') ? zdrJson : modelsJson
    return new Response(JSON.stringify(json), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
    })
  }
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
    const qwen = models.find((m) => m.id === 'qwen/qwen3-235b-a22b:free')
    assert.ok(qwen)
    assert.equal(qwen.free, true)
    assert.equal(qwen.supportsTools, true)
    assert.equal(qwen.contextLength, 262144)
    assert.equal(qwen.inputPricePerMTok, 0)
    assert.equal(qwen.outputPricePerMTok, 0)

    const claude = models.find((m) => m.id === 'anthropic/claude-3.5-sonnet')
    assert.ok(claude)
    assert.equal(claude.free, false)
    assert.equal(claude.inputPricePerMTok, 3)
    assert.equal(claude.outputPricePerMTok, 15)
  })

  it('tolerates null pricing and array-shaped junk rows', () => {
    assert.deepEqual(
      parseOpenRouterModelsPayload({ data: [[], { id: 'example/model', pricing: null }] }),
      [
        {
          id: 'example/model',
          name: 'example/model',
          contextLength: null,
          free: false,
          supportsTools: false,
          inputPricePerMTok: null,
          outputPricePerMTok: null,
        },
      ],
    )
  })
})

describe('listFreeOpenRouterModels', () => {
  let restore: (() => void) | undefined
  afterEach(async () => {
    restore?.()
    restore = undefined
    invalidateOpenRouterModelsCache()
    await setSetting('openRouterZdrOnly', true)
    await setSetting('openRouterFreeMode', false)
  })

  it('includes paid, tool-capable models by default when openRouterFreeMode is unset', async () => {
    invalidateOpenRouterModelsCache()
    restore = stubFetch(SAMPLE)
    const models = await listFreeOpenRouterModels()
    assert.deepEqual(
      models.map((m) => m.id).sort(),
      ['anthropic/claude-3.5-sonnet', 'qwen/qwen3-235b-a22b:free'].sort(),
    )
    assert.equal(
      models.find((model) => model.id === 'anthropic/claude-3.5-sonnet')?.inputPricePerMTok,
      3,
    )
  })

  it('returns only free, tool-capable models when openRouterFreeMode is true', async () => {
    invalidateOpenRouterModelsCache()
    await setSetting('openRouterFreeMode', true)
    restore = stubFetch(SAMPLE)
    const models = await listFreeOpenRouterModels()
    assert.deepEqual(
      models.map((m) => m.id),
      ['qwen/qwen3-235b-a22b:free'],
    )
  })

  it('keeps ZDR-capable models when the ZDR list matches by display name', async () => {
    invalidateOpenRouterModelsCache()
    restore = stubFetch(SAMPLE, ZDR_SAMPLE)
    const models = await listFreeOpenRouterModels()
    assert.deepEqual(
      models.map((m) => m.id),
      ['qwen/qwen3-235b-a22b:free'],
    )
  })

  it('drops models with no ZDR endpoint while ZDR-only routing is on', async () => {
    invalidateOpenRouterModelsCache()
    restore = stubFetch(SAMPLE, {
      data: [{ name: 'x', model_name: 'Some Other Model', provider_name: 'p' }],
    })
    const models = await listFreeOpenRouterModels()
    assert.deepEqual(models, [])
  })

  it('does not filter when ZDR-only routing is off', async () => {
    invalidateOpenRouterModelsCache()
    await setSetting('openRouterZdrOnly', false)
    restore = stubFetch(SAMPLE, {
      data: [{ name: 'x', model_name: 'Some Other Model', provider_name: 'p' }],
    })
    const models = await listFreeOpenRouterModels()
    assert.deepEqual(
      models.map((m) => m.id).sort(),
      ['anthropic/claude-3.5-sonnet', 'qwen/qwen3-235b-a22b:free'].sort(),
    )
  })

  it('includes paid, tool-capable models when openRouterFreeMode is false', async () => {
    invalidateOpenRouterModelsCache()
    await setSetting('openRouterFreeMode', false)
    restore = stubFetch(SAMPLE)
    const models = await listFreeOpenRouterModels()
    assert.deepEqual(
      models.map((m) => m.id).sort(),
      ['anthropic/claude-3.5-sonnet', 'qwen/qwen3-235b-a22b:free'].sort(),
    )
  })

  it('exposes context length from the cached catalog', async () => {
    invalidateOpenRouterModelsCache()
    restore = stubFetch(SAMPLE)
    const ctx = await openRouterModelContextLength('anthropic/claude-3.5-sonnet')
    assert.equal(ctx, 200000)
  })
})

describe('filterToZdrModels', () => {
  const models = [
    {
      id: 'qwen/qwen3-235b-a22b:free',
      name: 'Qwen3 235B A22B (free)',
      inputPricePerMTok: 0,
      outputPricePerMTok: 0,
    },
    {
      id: 'z-ai/glm-4.5-air:free',
      name: 'GLM 4.5 Air (free)',
      inputPricePerMTok: 0,
      outputPricePerMTok: 0,
    },
  ]

  it('fails open on an empty identifier set', () => {
    assert.deepEqual(filterToZdrModels(models, new Set()), models)
  })

  it('matches case-insensitively on display name or id', () => {
    assert.deepEqual(
      filterToZdrModels(models, new Set(['qwen3 235b a22b (free)'])).map((m) => m.id),
      ['qwen/qwen3-235b-a22b:free'],
    )
    assert.deepEqual(
      filterToZdrModels(models, new Set(['z-ai/glm-4.5-air:free'])).map((m) => m.id),
      ['z-ai/glm-4.5-air:free'],
    )
  })
})
