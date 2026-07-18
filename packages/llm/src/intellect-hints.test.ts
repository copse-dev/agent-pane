import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  cloudModelIntellectHint,
  localModelIntellectHint,
  modelIntellectHint,
} from './intellect-hints.ts'

describe('cloudModelIntellectHint', () => {
  it('shows intellect, blended price, and frontier for a scored tracked model', () => {
    // Opus 4.8: measured 56 on canonical, $5/$25 → $9/MTok blended, and the
    // highest-intellect tracked model, so on the frontier.
    assert.equal(cloudModelIntellectHint('claude-opus-4-8'), 'intellect 56 · $9/MTok · frontier')
  })

  it('shows price without a score for an unscored tracked model', () => {
    const hint = cloudModelIntellectHint('gpt-4o')
    assert.ok(hint)
    assert.match(hint, /^\$[\d.]+\/MTok$/)
    assert.doesNotMatch(hint, /intellect/)
    assert.doesNotMatch(hint, /frontier/)
  })

  it('returns null for an unknown model so the picker renders it unchanged', () => {
    assert.equal(cloudModelIntellectHint('made-up-model'), null)
  })
})

describe('modelIntellectHint', () => {
  it('gives an intellect-only hint for alias and vendor id forms', () => {
    assert.equal(modelIntellectHint('Opus 4.8'), 'intellect 56')
    assert.equal(modelIntellectHint('moonshotai/kimi-k2.6'), 'intellect 54')
    assert.equal(modelIntellectHint('totally-unknown'), null)
  })
})

describe('localModelIntellectHint', () => {
  it('labels a composite on its own scale, never as canonical intellect', () => {
    // qwen2.5-coder-32b has 3 sourced axes and no canonical measurement.
    const hint = localModelIntellectHint('qwen/qwen2.5-coder-32b')
    assert.ok(hint)
    assert.match(hint, /^composite [\d.]+ \(3 axes\)$/)
    assert.doesNotMatch(hint, /intellect/)
  })

  it('returns null for models with neither a measurement nor enough axes', () => {
    assert.equal(localModelIntellectHint('microsoft/phi-4'), null)
    assert.equal(localModelIntellectHint('unknown/model'), null)
  })
})
