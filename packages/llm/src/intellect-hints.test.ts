import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  cloudModelIntellectHint,
  localModelIntellectHint,
  modelIntellectHint,
} from './intellect-hints.ts'
import { getIntellectScore } from './model-intellect.ts'

function intellectHint(modelId: string): string {
  const score = getIntellectScore(modelId)
  assert.ok(score, `expected a synced intellect score for ${modelId}`)
  return `intellect ${score.estimated ? '~' : ''}${String(score.value)}`
}

describe('cloudModelIntellectHint', () => {
  it('shows intellect, blended price, and frontier for a scored tracked model', () => {
    const opus5Hint = cloudModelIntellectHint('claude-opus-5')
    assert.ok(opus5Hint)
    assert.match(opus5Hint, new RegExp(`^${intellectHint('claude-opus-5')} · \\$9/MTok`))
    assert.match(opus5Hint, /frontier/)

    // Opus 4.8 costs the same but has lower intellect, so Opus 5 dominates it.
    const opus48Hint = cloudModelIntellectHint('claude-opus-4-8')
    assert.ok(opus48Hint)
    assert.match(opus48Hint, new RegExp(`^${intellectHint('claude-opus-4-8')} · \\$9/MTok`))
    assert.doesNotMatch(opus48Hint, /frontier/)
  })

  it('shows intellect and price but no frontier tag for a dominated tracked model', () => {
    const hint = cloudModelIntellectHint('gpt-4o')
    assert.ok(hint)
    assert.match(hint, new RegExp(`^${intellectHint('gpt-4o')} · \\$[\\d.]+/MTok$`))
    assert.doesNotMatch(hint, /frontier/)
  })

  it('returns null for an unknown model so the picker renders it unchanged', () => {
    assert.equal(cloudModelIntellectHint('made-up-model'), null)
  })
})

describe('modelIntellectHint', () => {
  it('gives an intellect-only hint for alias and vendor id forms', () => {
    assert.equal(modelIntellectHint('Opus 4.8'), intellectHint('claude-opus-4-8'))
    assert.equal(modelIntellectHint('claude-fable-5[1m]'), intellectHint('claude-fable-5'))
    // Both carry a direct v4.1 reading now, so the hint is a fact, not an estimate.
    assert.equal(modelIntellectHint('moonshotai/kimi-k2.6'), intellectHint('moonshotai/kimi-k2.6'))
    assert.equal(
      modelIntellectHint('MiniMaxAI/MiniMax-M3:novita'),
      intellectHint('MiniMaxAI/MiniMax-M3'),
    )
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
