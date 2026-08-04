import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { setSetting } from '../storage/settings.ts'
import {
  OPENROUTER_PRICING_KEY,
  getPersistedOpenRouterPricing,
  rememberOpenRouterPricing,
  resolveModelPricing,
} from './model-pricing-store.ts'

describe('model pricing store', () => {
  beforeEach(async () => {
    await setSetting(OPENROUTER_PRICING_KEY, {})
    await setSetting('extraProviders', [])
  })

  it('persists catalog rates under the ledger selection key', async () => {
    await rememberOpenRouterPricing([
      { id: 'z-ai/glm-5.2', inputPricePerMTok: 0.4, outputPricePerMTok: 1.6 },
    ])
    assert.deepEqual(getPersistedOpenRouterPricing()['openrouter:z-ai/glm-5.2'], {
      inputPricePerMTok: 0.4,
      outputPricePerMTok: 1.6,
    })
  })

  it('keeps rates for models that have left the catalog', async () => {
    await rememberOpenRouterPricing([
      { id: 'vendor/retired', inputPricePerMTok: 2, outputPricePerMTok: 4 },
    ])
    await rememberOpenRouterPricing([
      { id: 'vendor/current', inputPricePerMTok: 1, outputPricePerMTok: 3 },
    ])
    const persisted = getPersistedOpenRouterPricing()
    // The ledger shows a 90-day window, so a delisted model must stay priced.
    assert.equal(persisted['openrouter:vendor/retired']?.inputPricePerMTok, 2)
    assert.equal(persisted['openrouter:vendor/current']?.inputPricePerMTok, 1)
  })

  it('takes the newer rate when a model is repriced upstream', async () => {
    await rememberOpenRouterPricing([{ id: 'a/b', inputPricePerMTok: 1, outputPricePerMTok: 1 }])
    await rememberOpenRouterPricing([{ id: 'a/b', inputPricePerMTok: 5, outputPricePerMTok: 9 }])
    assert.equal(getPersistedOpenRouterPricing()['openrouter:a/b']?.outputPricePerMTok, 9)
  })

  it('leaves a good snapshot alone when a fetch yields no priced rows', async () => {
    await rememberOpenRouterPricing([{ id: 'a/b', inputPricePerMTok: 1, outputPricePerMTok: 2 }])
    await rememberOpenRouterPricing([])
    await rememberOpenRouterPricing([
      { id: 'a/c', inputPricePerMTok: null, outputPricePerMTok: null },
    ])
    assert.equal(getPersistedOpenRouterPricing()['openrouter:a/b']?.inputPricePerMTok, 1)
  })

  it('merges OpenRouter and extra-provider rates into one map', async () => {
    await rememberOpenRouterPricing([
      { id: 'z-ai/glm-5.2', inputPricePerMTok: 0.4, outputPricePerMTok: 1.6 },
    ])
    await setSetting('extraProviders', [
      {
        slug: 'huggingface',
        models: [{ id: 'org/model', inputPricePerMTok: 0.6, outputPricePerMTok: 2.2 }],
      },
    ])
    const pricing = resolveModelPricing()
    assert.equal(pricing['openrouter:z-ai/glm-5.2']?.inputPricePerMTok, 0.4)
    assert.equal(pricing['huggingface:org/model']?.outputPricePerMTok, 2.2)
  })
})
