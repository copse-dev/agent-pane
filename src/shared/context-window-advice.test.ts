import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  RECOMMENDED_MIN_CONTEXT_WINDOW,
  bestKnownContextWindow,
  contextFitAdvice,
  hasDecentContextWindow,
  isContextWindowLow,
  lowContextAdvice,
} from './context-window-advice.ts'

describe('isContextWindowLow', () => {
  it('flags windows below the recommended minimum', () => {
    assert.equal(isContextWindowLow(4096), true)
    assert.equal(isContextWindowLow(RECOMMENDED_MIN_CONTEXT_WINDOW - 1), true)
  })

  it('does not flag windows at or above the minimum', () => {
    assert.equal(isContextWindowLow(RECOMMENDED_MIN_CONTEXT_WINDOW), false)
    assert.equal(isContextWindowLow(128_000), false)
  })

  it('does not flag unknown or non-positive windows', () => {
    assert.equal(isContextWindowLow(null), false)
    assert.equal(isContextWindowLow(undefined), false)
    assert.equal(isContextWindowLow(0), false)
  })

  it('honours a custom minimum', () => {
    assert.equal(isContextWindowLow(8192, 4096), false)
    assert.equal(isContextWindowLow(8192, 16_384), true)
  })
})

describe('lowContextAdvice', () => {
  it('returns null when context is unknown or sufficient', () => {
    assert.equal(lowContextAdvice(null), null)
    assert.equal(lowContextAdvice(32_000), null)
  })

  it('builds a message that names the model and mentions LM Studio', () => {
    const msg = lowContextAdvice(4096, { modelId: 'tiny-model' })
    assert.ok(msg)
    assert.match(msg, /tiny-model/)
    assert.match(msg, /4K/)
    assert.match(msg, /16K/)
    assert.match(msg, /LM Studio/)
  })

  it('falls back to a generic subject without a model id', () => {
    const msg = lowContextAdvice(4096)
    assert.ok(msg)
    assert.match(msg, /This model/)
  })
})

describe('bestKnownContextWindow', () => {
  it('returns the largest positive window', () => {
    assert.equal(bestKnownContextWindow([4096, 32_768, 8192]), 32_768)
  })

  it('ignores null/undefined/non-positive entries', () => {
    assert.equal(bestKnownContextWindow([null, undefined, 0, 4096]), 4096)
  })

  it('returns null when nothing is known', () => {
    assert.equal(bestKnownContextWindow([]), null)
    assert.equal(bestKnownContextWindow([null, undefined, 0]), null)
  })
})

describe('hasDecentContextWindow', () => {
  it('is true when any window reaches the minimum', () => {
    assert.equal(hasDecentContextWindow([4096, RECOMMENDED_MIN_CONTEXT_WINDOW]), true)
    assert.equal(hasDecentContextWindow([200_000]), true)
  })

  it('is false when every window is below the minimum or unknown', () => {
    assert.equal(hasDecentContextWindow([4096, 8192]), false)
    assert.equal(hasDecentContextWindow([null, undefined, 0]), false)
    assert.equal(hasDecentContextWindow([]), false)
  })

  it('honours a custom minimum', () => {
    assert.equal(hasDecentContextWindow([8192], 4096), true)
    assert.equal(hasDecentContextWindow([8192], 16_384), false)
  })
})

describe('contextFitAdvice', () => {
  it('stays silent while the prompt fits comfortably', () => {
    assert.equal(contextFitAdvice({ totalTokens: 40_000, contextWindow: 200_000 }), null)
    // Right below the threshold: still room for a few turns.
    assert.equal(contextFitAdvice({ totalTokens: 8000, contextWindow: 10_000 }), null)
  })

  it('says nothing when there is no usable estimate', () => {
    assert.equal(contextFitAdvice(null), null)
    assert.equal(contextFitAdvice(undefined), null)
    assert.equal(contextFitAdvice({ totalTokens: 12_000, contextWindow: 0 }), null)
    assert.equal(contextFitAdvice({ totalTokens: 0, contextWindow: 8192 }), null)
  })

  it('explains an overflowing thread with both ways out', () => {
    const advice = contextFitAdvice(
      { totalTokens: 21_400, contextWindow: 8000 },
      { modelLabel: 'qwen3-4b' },
    )
    assert.ok(advice)
    assert.equal(advice.level, 'over')
    assert.match(advice.message, /no longer fits “qwen3-4b”/)
    assert.match(advice.message, /21\.4K tokens/)
    assert.match(advice.message, /context window holds 8K/)
    assert.match(advice.message, /Pick a model with a larger context window/)
    assert.match(advice.message, /start a new thread/)
  })

  it('warns before the window is full, naming the share used', () => {
    const advice = contextFitAdvice(
      { totalTokens: 7600, contextWindow: 8000 },
      { modelLabel: 'qwen3-4b' },
    )
    assert.ok(advice)
    assert.equal(advice.level, 'near')
    assert.match(advice.message, /already fills 95% of the 8K context window/)
    assert.match(advice.message, /older messages will be trimmed/)
    assert.match(advice.message, /Pick a model with a larger context window/)
  })

  it('adds the load-time fix only for local models', () => {
    const local = contextFitAdvice(
      { totalTokens: 12_000, contextWindow: 8000 },
      { modelLabel: 'qwen3-4b', lmStudioModel: true },
    )
    assert.match(local?.message ?? '', /“Context Length” in LM Studio/)
    const cloud = contextFitAdvice({ totalTokens: 300_000, contextWindow: 200_000 })
    assert.ok(cloud)
    assert.doesNotMatch(cloud.message, /LM Studio/)
    assert.match(cloud.message, /the selected model/)
  })

  it('honours a custom threshold', () => {
    const fit = { totalTokens: 8000, contextWindow: 10_000 }
    assert.equal(contextFitAdvice(fit), null)
    assert.equal(contextFitAdvice(fit, { nearlyFullRatio: 0.75 })?.level, 'near')
  })
})
