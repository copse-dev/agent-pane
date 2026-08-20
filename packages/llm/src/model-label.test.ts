import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalModelLabel, claudeModelIdFromLabel } from './model-label.ts'

describe('canonicalModelLabel', () => {
  it('names the vendor a bare family name leaves out', () => {
    assert.equal(canonicalModelLabel('Opus 5'), 'Claude Opus 5')
    assert.equal(canonicalModelLabel('Sonnet 4.6'), 'Claude Sonnet 4.6')
    assert.equal(canonicalModelLabel('haiku 4.5'), 'Claude Haiku 4.5')
    assert.equal(canonicalModelLabel('Fable 5'), 'Claude Fable 5')
  })

  it("puts Cursor's version-first spelling back in family order, qualifier intact", () => {
    assert.equal(canonicalModelLabel('Claude 4.6 Sonnet'), 'Claude Sonnet 4.6')
    assert.equal(
      canonicalModelLabel('Claude 4.6 Sonnet (Thinking)'),
      'Claude Sonnet 4.6 (Thinking)',
    )
    assert.equal(canonicalModelLabel('Opus 5 (1M context)'), 'Claude Opus 5 (1M context)')
  })

  it('spells a raw id the way the picker spells every other row', () => {
    assert.equal(canonicalModelLabel('claude-opus-4-7'), 'Claude Opus 4.7')
    assert.equal(canonicalModelLabel('claude-opus-5'), 'Claude Opus 5')
    assert.equal(canonicalModelLabel('opus-4-8'), 'Claude Opus 4.8')
  })

  it('spells GPT ids and agent labels in the tracked-model house style', () => {
    assert.equal(canonicalModelLabel('gpt-5.4-nano'), 'GPT-5.4 nano')
    assert.equal(canonicalModelLabel('gpt-5.1'), 'GPT-5.1')
    assert.equal(canonicalModelLabel('gpt-5-mini'), 'GPT-5 mini')
    assert.equal(canonicalModelLabel('GPT-5.6-Sol'), 'GPT-5.6 Sol')
    assert.equal(canonicalModelLabel('gpt-4o-mini'), 'GPT-4o mini')
  })

  it('is idempotent on names already in house style', () => {
    for (const label of [
      'Claude Opus 4.8',
      'Claude Sonnet 4.6 (Thinking)',
      'Claude Fable 5',
      'GPT-5.6 Sol',
      'GPT-5 mini',
    ]) {
      assert.equal(canonicalModelLabel(label), label)
      assert.equal(canonicalModelLabel(canonicalModelLabel(label)), label)
    }
  })

  it('leaves alone every name it does not recognise', () => {
    // Other vendors, Cursor's own models, local weights: not ours to rename.
    for (const label of [
      'Composer 2',
      'Grok 4.5',
      'qwen3.6-35b-a3b',
      'Auto',
      'Default (recommended)',
    ]) {
      assert.equal(canonicalModelLabel(label), label)
    }
  })

  it('leaves ids whose tail it does not model untouched rather than half-rewriting them', () => {
    // A dated snapshot, a `-latest` alias, and an option suffix each carry
    // meaning past the version that a rename would drop.
    assert.equal(canonicalModelLabel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5-20251001')
    assert.equal(canonicalModelLabel('claude-opus-4-8-latest'), 'claude-opus-4-8-latest')
    assert.equal(canonicalModelLabel('claude-fable-5[1m]'), 'claude-fable-5[1m]')
    assert.equal(canonicalModelLabel('gpt-5-2025-08-07'), 'gpt-5-2025-08-07')
  })
})

describe('claudeModelIdFromLabel', () => {
  it('resolves a plain family + version to the catalog id', () => {
    assert.equal(claudeModelIdFromLabel('Opus 4.8'), 'claude-opus-4-8')
    assert.equal(claudeModelIdFromLabel('Claude 4.6 Sonnet'), 'claude-sonnet-4-6')
    assert.equal(claudeModelIdFromLabel('claude-opus-4-8'), 'claude-opus-4-8')
  })

  it('refuses a qualified name, which describes a different configuration', () => {
    assert.equal(claudeModelIdFromLabel('Claude 4.6 Sonnet (Thinking)'), null)
    assert.equal(claudeModelIdFromLabel('Opus 5 (1M context)'), null)
  })

  it('refuses anything it does not recognise as a Claude name', () => {
    assert.equal(claudeModelIdFromLabel('Composer 2'), null)
    assert.equal(claudeModelIdFromLabel('GPT-5.6 Sol'), null)
    assert.equal(claudeModelIdFromLabel('claude-haiku-4-5-20251001'), null)
  })
})
