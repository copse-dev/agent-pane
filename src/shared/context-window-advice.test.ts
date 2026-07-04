import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  RECOMMENDED_MIN_CONTEXT_WINDOW,
  bestKnownContextWindow,
  hasDecentContextWindow,
  isContextWindowLow,
  lowContextAdvice,
  noDecentChatDefaultAdvice,
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

describe('noDecentChatDefaultAdvice', () => {
  it('names the largest available window when one is known', () => {
    const msg = noDecentChatDefaultAdvice(8192)
    assert.match(msg, /8K/)
    assert.match(msg, /16K/)
    assert.match(msg, /LM Studio/)
  })

  it('handles the case where nothing reports a window', () => {
    const msg = noDecentChatDefaultAdvice(null)
    assert.match(msg, /no available model/)
    assert.match(msg, /cloud API key/)
  })
})
