import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  cloudModelIntellectHint,
  localModelIntellectHint,
  modelIntellectHint,
} from './intellect-hints.ts'

describe('cloudModelIntellectHint', () => {
  it('shows intellect, blended price, and frontier for a scored tracked model', () => {
    // Opus 4.8: measured 55.7 on canonical, $5/$25 → $9/MTok blended, and on the
    // cost/intellect frontier.
    assert.equal(cloudModelIntellectHint('claude-opus-4-8'), 'intellect 55.7 · $9/MTok · frontier')
  })

  it('shows intellect and price but no frontier tag for a dominated tracked model', () => {
    // gpt-4o is scored (11.2) but neither cheapest nor smartest, so it's off the
    // frontier — the hint carries intellect and price without the frontier tag.
    const hint = cloudModelIntellectHint('gpt-4o')
    assert.ok(hint)
    assert.match(hint, /^intellect 11\.2 · \$[\d.]+\/MTok$/)
    assert.doesNotMatch(hint, /frontier/)
  })

  it('returns null for an unknown model so the picker renders it unchanged', () => {
    assert.equal(cloudModelIntellectHint('made-up-model'), null)
  })
})

describe('modelIntellectHint', () => {
  it('gives an intellect-only hint for alias and vendor id forms', () => {
    assert.equal(modelIntellectHint('Opus 4.8'), 'intellect 55.7')
    assert.equal(modelIntellectHint('claude-fable-5[1m]'), 'intellect 59.9')
    // Both carry a direct v4.1 reading now, so the hint is a fact, not an estimate.
    assert.equal(modelIntellectHint('moonshotai/kimi-k2.6'), 'intellect 44.2')
    assert.equal(modelIntellectHint('MiniMaxAI/MiniMax-M3:novita'), 'intellect 44.4')
    assert.equal(modelIntellectHint('totally-unknown'), null)
  })
})

describe('localModelIntellectHint', () => {
  it('shows a quant-adjusted measurement for a local model with an AA score', () => {
    // qwen2.5-coder-32b now carries a sourced AA measurement; the local hint
    // shows it quant-adjusted (~) for the running quant, not raw fp16.
    const hint = localModelIntellectHint('qwen/qwen2.5-coder-32b')
    assert.ok(hint)
    assert.match(hint, /^intellect ~[\d.]+$/)
  })

  it('returns null for models with neither a measurement nor enough axes', () => {
    assert.equal(localModelIntellectHint('qwen/qwen3-4b-2507'), null)
    assert.equal(localModelIntellectHint('unknown/model'), null)
  })
})
