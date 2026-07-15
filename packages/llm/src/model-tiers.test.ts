import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TRACKED_MODELS } from './model-catalog.ts'
import {
  CLOUD_MODEL_TIERS,
  TIER_REPRESENTATIVE_MODEL,
  cloudModelTier,
  compareModelTiers,
} from './model-tiers.ts'

describe('cloud model tiers', () => {
  it('annotates every tracked model, and nothing else', () => {
    assert.deepEqual(Object.keys(CLOUD_MODEL_TIERS).sort(), [...TRACKED_MODELS].sort())
  })

  it('resolves a tier for tracked ids and null for unknown/local ids', () => {
    assert.equal(cloudModelTier('claude-opus-4-8'), 'frontier')
    assert.equal(cloudModelTier('claude-haiku-4-5'), 'fast')
    assert.equal(cloudModelTier('lmstudio:qwen/qwen2.5-coder-32b'), null)
    assert.equal(cloudModelTier(''), null)
  })

  it('orders tiers fast < balanced < frontier', () => {
    assert.ok(compareModelTiers('fast', 'balanced') < 0)
    assert.ok(compareModelTiers('balanced', 'frontier') < 0)
    assert.ok(compareModelTiers('frontier', 'fast') > 0)
    assert.equal(compareModelTiers('balanced', 'balanced'), 0)
  })

  it('picks a representative model annotated with its own tier', () => {
    for (const [tier, model] of Object.entries(TIER_REPRESENTATIVE_MODEL)) {
      assert.equal(CLOUD_MODEL_TIERS[model], tier)
    }
  })
})
