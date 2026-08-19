import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalModelLabel, claudeModelIdFromLabel, modelDisplayName } from './model-label.ts'

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
      'Gemini 2.5 Pro',
      'DeepSeek Chat V3.1',
      'Mistral Small Latest',
      'GLM-4.6',
      'GLM-4.5 Air',
    ]) {
      assert.equal(canonicalModelLabel(label), label)
      assert.equal(canonicalModelLabel(canonicalModelLabel(label)), label)
    }
  })

  it('spells the other named vendors in the same house style', () => {
    assert.equal(canonicalModelLabel('gemini-2.5-pro'), 'Gemini 2.5 Pro')
    assert.equal(canonicalModelLabel('gemini-2.5-flash-lite'), 'Gemini 2.5 Flash Lite')
    assert.equal(canonicalModelLabel('deepseek-chat-v3.1'), 'DeepSeek Chat V3.1')
    assert.equal(canonicalModelLabel('mistral-small-latest'), 'Mistral Small Latest')
    // GLM keeps the GPT-style hyphen before the version.
    assert.equal(canonicalModelLabel('glm-4.6'), 'GLM-4.6')
    assert.equal(canonicalModelLabel('glm-4.5-air'), 'GLM-4.5 Air')
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

describe('modelDisplayName', () => {
  it('spells an unrecognised id as a name, so the only dash in a row is ours', () => {
    // Copse appends its own annotations with an em dash ("— intellect 40.6").
    // A row whose name is itself a run of hyphens makes the reader work out
    // which dash is the app talking.
    assert.equal(modelDisplayName('apertus-70b'), 'Apertus 70B')
    assert.equal(modelDisplayName('qwen3.8-max'), 'Qwen3.8 Max')
    assert.equal(modelDisplayName('qwen3guard-gen-0.6b'), 'Qwen3guard Gen 0.6B')
    assert.equal(modelDisplayName('paraphrase-multilingual-mpnet'), 'Paraphrase Multilingual MPNet')
    assert.equal(modelDisplayName('qwen3-vl-30b-a3b'), 'Qwen3 VL 30B A3B')
    assert.equal(modelDisplayName('gemma-3-27b-it'), 'Gemma 3 27B IT')
    assert.equal(modelDisplayName('gpt-oss-120b'), 'GPT OSS 120B')
    assert.equal(modelDisplayName('deepseek-r1'), 'DeepSeek R1')
  })

  it('rejoins a version written as separate segments', () => {
    // `5-6` is one version, not two tokens; splitting it reads as a different
    // model. The measurement catalog is full of this shape.
    assert.equal(modelDisplayName('gpt-5-6-sol'), 'GPT 5.6 Sol')
    assert.equal(modelDisplayName('claude-opus-4-7-non-reasoning'), 'Claude Opus 4.7 Non Reasoning')
  })

  it('defers to the house style whenever canonicalModelLabel claims the name', () => {
    assert.equal(modelDisplayName('claude-opus-4-8'), 'Claude Opus 4.8')
    assert.equal(modelDisplayName('gpt-5-mini'), 'GPT-5 mini')
    assert.equal(modelDisplayName('glm-4.6'), 'GLM-4.6')
  })

  it('leaves alone what is not an id to spell', () => {
    for (const name of [
      // Already a display name.
      'Composer 2',
      'Grok 4.5',
      'Auto',
      // An address, not a name: the halves are not ours to merge.
      'qwen/qwen3.6-35b-a3b',
      // Tails a rewrite would silently drop.
      'claude-haiku-4-5-20251001',
      'claude-opus-4-8-latest',
      'claude-fable-5[1m]',
      'gpt-5-2025-08-07',
    ]) {
      assert.equal(modelDisplayName(name), name)
    }
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
