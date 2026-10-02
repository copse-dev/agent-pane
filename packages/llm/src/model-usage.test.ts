import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  mergeModelUsage,
  repairLegacyAcpInputTokens,
  splitServiceTierUsage,
} from './model-usage.ts'

describe('model usage service-tier buckets', () => {
  it('merges independent tier buckets alongside the total', () => {
    const usage = mergeModelUsage(
      {
        inputTokens: 100,
        outputTokens: 10,
        serviceTierUsage: { flex: { inputTokens: 100, outputTokens: 10 } },
      },
      {
        inputTokens: 200,
        outputTokens: 20,
        serviceTierUsage: { priority: { inputTokens: 200, outputTokens: 20 } },
      },
    )
    assert.deepEqual(usage, {
      inputTokens: 300,
      outputTokens: 30,
      serviceTierUsage: {
        flex: { inputTokens: 100, outputTokens: 10 },
        priority: { inputTokens: 200, outputTokens: 20 },
      },
    })
  })

  it('caps persisted tier buckets so malformed totals cannot double-count costs', () => {
    const split = splitServiceTierUsage({
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 75,
      serviceTierUsage: {
        flex: { inputTokens: 200, outputTokens: 100, cacheReadTokens: 200 },
        priority: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1 },
      },
    })
    assert.deepEqual(split, {
      standard: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
      tiers: {
        flex: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 75 },
        priority: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
      },
    })
  })

  it('drops impossible cache remainder instead of billing cached tokens twice', () => {
    const split = splitServiceTierUsage({
      inputTokens: 100,
      outputTokens: 0,
      cacheReadTokens: 80,
      serviceTierUsage: { flex: { inputTokens: 80, outputTokens: 0, cacheReadTokens: 0 } },
    })
    assert.deepEqual(split, {
      standard: { inputTokens: 20, outputTokens: 0, cacheReadTokens: 20 },
      tiers: { flex: { inputTokens: 80, outputTokens: 0, cacheReadTokens: 0 } },
    })
  })
})

describe('repairLegacyAcpInputTokens', () => {
  const legacy = {
    inputTokens: 3,
    outputTokens: 120,
    cacheReadTokens: 40_000,
    cacheCreationTokens: 1_200,
  }

  it('folds the cache share into a fresh-only ACP record, once', () => {
    const repaired = repairLegacyAcpInputTokens('acp:claude-acp#opus', legacy)
    assert.deepEqual(repaired, { ...legacy, inputTokens: 41_203 })
    // Idempotent: the repaired record satisfies input >= cache and is returned as-is.
    assert.equal(repairLegacyAcpInputTokens('acp:claude-acp#opus', repaired), repaired)
  })

  it('leaves ACP records whose input already covers the cache', () => {
    const usage = { inputTokens: 41_203, outputTokens: 120, cacheReadTokens: 40_000 }
    assert.equal(repairLegacyAcpInputTokens('acp:claude-acp#opus', usage), usage)
  })

  it('never touches non-ACP models', () => {
    assert.equal(repairLegacyAcpInputTokens('claude-opus-4-6', legacy), legacy)
    assert.equal(repairLegacyAcpInputTokens('openrouter:anthropic/claude-opus-4-6', legacy), legacy)
  })
})
