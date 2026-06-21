import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLOUD_MODELS,
  anthropicMaxOutputTokens,
  getModelInfo,
  inferCloudModelProvider,
  MODEL_CATALOG,
  TRACKED_MODELS,
} from './model-catalog.ts'

describe('model catalog', () => {
  it('has a generated entry for every tracked model (run `npm run sync:models` if this fails)', () => {
    const missing = TRACKED_MODELS.filter((m) => !(m in MODEL_CATALOG))
    assert.deepEqual(
      missing,
      [],
      `MODEL_CATALOG is missing entries for: ${missing.join(', ')}. Re-run \`npm run sync:models\` to regenerate model-catalog.generated.ts, or remove the id from TRACKED_MODELS if it is no longer shipped.`,
    )
  })

  it('exposes positive prices, context window, and max output tokens for every entry', () => {
    for (const [model, info] of Object.entries(MODEL_CATALOG)) {
      assert.ok(info.inputPricePerMTok > 0, `${model}: inputPricePerMTok must be > 0`)
      assert.ok(info.outputPricePerMTok > 0, `${model}: outputPricePerMTok must be > 0`)
      assert.ok(info.contextWindow > 0, `${model}: contextWindow must be > 0`)
      assert.ok(info.maxOutputTokens > 0, `${model}: maxOutputTokens must be > 0`)
    }
  })

  it('getModelInfo returns null for unknown models without throwing', () => {
    assert.equal(getModelInfo('not-a-real-model'), null)
    assert.equal(getModelInfo(''), null)
  })

  it('derives cloud model picker options from TRACKED_MODELS', () => {
    assert.deepEqual(
      CLOUD_MODELS.map(([value]) => value),
      [...TRACKED_MODELS],
    )
    for (const [value, label, provider] of CLOUD_MODELS) {
      assert.equal(label, value)
      assert.equal(provider, inferCloudModelProvider(value))
    }
  })

  it('infers provider from model id prefix', () => {
    assert.equal(inferCloudModelProvider('claude-sonnet-4-6'), 'anthropic')
    assert.equal(inferCloudModelProvider('gpt-4o'), 'openai')
    assert.throws(() => inferCloudModelProvider('llama-3'), /Unknown cloud model provider/)
  })

  it('returns the catalog maxOutputTokens for tracked Claude models', () => {
    for (const model of TRACKED_MODELS) {
      if (!model.startsWith('claude')) continue
      assert.equal(anthropicMaxOutputTokens(model), MODEL_CATALOG[model]?.maxOutputTokens)
    }
  })

  it('falls back to 8192 max output for unknown Anthropic models', () => {
    assert.equal(anthropicMaxOutputTokens('claude-unknown'), 8192)
  })
})
