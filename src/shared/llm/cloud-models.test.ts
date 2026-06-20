import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLOUD_MODELS,
  anthropicMaxOutputTokens,
  cloudModelContextWindow,
  cloudModelRates,
  getCloudModel,
} from './cloud-models.ts'

describe('CLOUD_MODELS', () => {
  it('defines context windows and pricing on each cloud model', () => {
    assert.ok(CLOUD_MODELS.length >= 2)
    for (const model of CLOUD_MODELS) {
      assert.ok(model.contextWindow > 0)
      assert.equal(model.rates.length, 2)
      assert.equal(getCloudModel(model.id)?.id, model.id)
    }
  })

  it('exposes lookup helpers used by main and renderer', () => {
    assert.equal(cloudModelContextWindow('gpt-4o'), 128_000)
    assert.deepEqual(cloudModelRates('claude-sonnet-4-6'), [3.0, 15.0])
    assert.equal(cloudModelContextWindow('unknown'), undefined)
    assert.equal(anthropicMaxOutputTokens('claude-sonnet-4-6'), 64_000)
    assert.equal(anthropicMaxOutputTokens('gpt-4o'), 8192)
  })
})
