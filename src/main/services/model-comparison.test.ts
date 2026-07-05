import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_COMPARISON_JUDGE_MODEL,
  DEFAULT_COMPARISON_MODEL_B,
  billableComparisonModels,
  buildComparisonJudgePrompt,
  comparisonApprovalBody,
  comparisonNeedsApproval,
  comparisonReviewersDistinct,
  resolveComparisonModels,
} from './model-comparison.ts'

describe('resolveComparisonModels', () => {
  it('falls back A to the chat model and B/judge to the frontier defaults', () => {
    assert.deepEqual(resolveComparisonModels({ chatModel: 'gpt-5' }), {
      a: 'gpt-5',
      b: DEFAULT_COMPARISON_MODEL_B,
      judge: DEFAULT_COMPARISON_JUDGE_MODEL,
    })
  })

  it('uses configured ids and trims whitespace', () => {
    assert.deepEqual(
      resolveComparisonModels({
        modelA: '  claude-haiku-4-5 ',
        modelB: 'gpt-5',
        judge: ' claude-opus-4-8 ',
        chatModel: 'claude-sonnet-4-6',
      }),
      { a: 'claude-haiku-4-5', b: 'gpt-5', judge: 'claude-opus-4-8' },
    )
  })

  it('treats a blank configured value as unset', () => {
    const models = resolveComparisonModels({ modelA: '   ', modelB: '', chatModel: 'lm-studio' })
    assert.equal(models.a, 'lm-studio')
    assert.equal(models.b, DEFAULT_COMPARISON_MODEL_B)
  })

  it('avoids a defaulted B colliding with A (Opus chat model)', () => {
    const models = resolveComparisonModels({ chatModel: DEFAULT_COMPARISON_MODEL_B })
    assert.equal(models.a, DEFAULT_COMPARISON_MODEL_B)
    assert.notEqual(models.b, models.a, 'defaulted B must differ from A')
  })

  it('respects an explicit B even when it equals A (user misconfig, surfaced later)', () => {
    const models = resolveComparisonModels({
      modelA: 'gpt-5',
      modelB: 'gpt-5',
      chatModel: 'gpt-5',
    })
    assert.equal(models.b, 'gpt-5')
    assert.equal(comparisonReviewersDistinct(models), false)
  })
})

describe('comparisonReviewersDistinct', () => {
  it('is false when both reviewers are the same model', () => {
    assert.equal(
      comparisonReviewersDistinct({ a: 'gpt-5', b: 'gpt-5', judge: 'claude-opus-4-8' }),
      false,
    )
  })

  it('is true when the reviewers differ', () => {
    assert.equal(
      comparisonReviewersDistinct({ a: 'gpt-5', b: 'claude-opus-4-8', judge: 'claude-opus-4-8' }),
      true,
    )
  })
})

describe('comparisonNeedsApproval / billableComparisonModels', () => {
  const isPaid = (m: string): boolean => !m.startsWith('lmstudio:')

  it('needs approval when any model is billable', () => {
    assert.equal(
      comparisonNeedsApproval({ a: 'lmstudio:a', b: 'gpt-5', judge: 'lmstudio:j' }, isPaid),
      true,
    )
  })

  it('does not need approval when every model is local', () => {
    assert.equal(
      comparisonNeedsApproval({ a: 'lmstudio:a', b: 'lmstudio:b', judge: 'lmstudio:j' }, isPaid),
      false,
    )
  })

  it('lists each billable model once', () => {
    assert.deepEqual(
      billableComparisonModels({ a: 'gpt-5', b: 'gpt-5', judge: 'claude-opus-4-8' }, isPaid),
      ['gpt-5', 'claude-opus-4-8'],
    )
  })
})

describe('comparisonApprovalBody', () => {
  it('names all three models and the billable calls', () => {
    const body = comparisonApprovalBody(
      { a: 'gpt-5', b: 'lmstudio:qwen', judge: 'claude-opus-4-8' },
      (m) => !m.startsWith('lmstudio:'),
    )
    assert.match(body, /Reviewer A: gpt-5/)
    assert.match(body, /Reviewer B: lmstudio:qwen/)
    assert.match(body, /Judge: claude-opus-4-8/)
    assert.match(body, /billable calls to: gpt-5, claude-opus-4-8/)
  })

  it('states no charge when everything is local', () => {
    const body = comparisonApprovalBody(
      { a: 'lmstudio:a', b: 'lmstudio:b', judge: 'lmstudio:j' },
      () => false,
    )
    assert.match(body, /local \(no charge\)/)
  })
})

describe('buildComparisonJudgePrompt', () => {
  it('embeds both reviews under labelled model headings', () => {
    const prompt = buildComparisonJudgePrompt(
      'Fix the parser',
      { a: 'gpt-5', b: 'claude-opus-4-8', judge: 'claude-opus-4-8' },
      'A says looks fine',
      'B found a bug',
    )
    assert.match(prompt, /# Review A — gpt-5/)
    assert.match(prompt, /A says looks fine/)
    assert.match(prompt, /# Review B — claude-opus-4-8/)
    assert.match(prompt, /B found a bug/)
    assert.match(prompt, /Fix the parser/)
  })

  it('substitutes a placeholder for an empty review', () => {
    const prompt = buildComparisonJudgePrompt(
      'goal',
      { a: 'gpt-5', b: 'gpt-4o', judge: 'gpt-5' },
      '',
      'B verdict',
    )
    assert.match(prompt, /\(no output\)/)
  })
})
