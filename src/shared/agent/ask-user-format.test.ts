import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  askUserParamsSchema,
  formatAnswersResult,
  formatQuestionsBody,
  pairQuestionsWithAnswers,
} from './ask-user-format.ts'

describe('askUserParamsSchema validation', () => {
  it('accepts a single question with no options', () => {
    const parsed = askUserParamsSchema.safeParse({ questions: [{ question: 'Which DB?' }] })
    assert.equal(parsed.success, true)
  })

  it('accepts questions with options', () => {
    const parsed = askUserParamsSchema.safeParse({
      questions: [{ question: 'Which DB?', options: ['Postgres', 'SQLite'] }],
    })
    assert.equal(parsed.success, true)
  })

  it('rejects an empty questions array', () => {
    assert.equal(askUserParamsSchema.safeParse({ questions: [] }).success, false)
  })

  it('rejects an empty question string', () => {
    assert.equal(askUserParamsSchema.safeParse({ questions: [{ question: '' }] }).success, false)
  })

  it('rejects an empty option string', () => {
    const parsed = askUserParamsSchema.safeParse({
      questions: [{ question: 'Pick', options: [''] }],
    })
    assert.equal(parsed.success, false)
  })

  it('rejects more than ten questions', () => {
    const questions = Array.from({ length: 11 }, (_, i) => ({ question: `q${String(i)}` }))
    assert.equal(askUserParamsSchema.safeParse({ questions }).success, false)
  })
})

describe('formatQuestionsBody', () => {
  it('renders a single question without numbering', () => {
    assert.equal(formatQuestionsBody([{ question: 'Which DB?' }]), 'Which DB?')
  })

  it('numbers multiple questions and indents options', () => {
    const body = formatQuestionsBody([
      { question: 'Which DB?', options: ['Postgres', 'SQLite'] },
      { question: 'Async?' },
    ])
    assert.equal(body, '1. Which DB?\n   - Postgres\n   - SQLite\n2. Async?')
  })
})

describe('formatAnswersResult', () => {
  it('returns just the answer for a single question', () => {
    assert.equal(
      formatAnswersResult([{ question: 'Which DB?', answer: 'Postgres' }]),
      'The user answered: Postgres',
    )
  })

  it('echoes each question with its answer for multiple questions', () => {
    const result = formatAnswersResult([
      { question: 'Which DB?', answer: 'Postgres' },
      { question: 'Async?', answer: 'Yes' },
    ])
    assert.equal(result, 'The user answered:\n- Which DB? → Postgres\n- Async? → Yes')
  })

  it('reports a blank answer as (no answer)', () => {
    assert.equal(
      formatAnswersResult([{ question: 'Which DB?', answer: '   ' }]),
      'The user answered: (no answer)',
    )
  })

  it('trims surrounding whitespace from answers', () => {
    assert.equal(
      formatAnswersResult([{ question: 'Which DB?', answer: '  Postgres  ' }]),
      'The user answered: Postgres',
    )
  })

  it('handles an empty answer list without throwing', () => {
    assert.equal(formatAnswersResult([]), 'The user did not answer.')
  })
})

describe('pairQuestionsWithAnswers', () => {
  it('pairs questions to answers by index', () => {
    const paired = pairQuestionsWithAnswers([{ question: 'A' }, { question: 'B' }], ['1', '2'])
    assert.deepEqual(paired, [
      { question: 'A', answer: '1' },
      { question: 'B', answer: '2' },
    ])
  })

  it('fills missing answers with empty strings', () => {
    const paired = pairQuestionsWithAnswers([{ question: 'A' }, { question: 'B' }], ['1'])
    assert.deepEqual(paired, [
      { question: 'A', answer: '1' },
      { question: 'B', answer: '' },
    ])
  })

  it('drops extra answers beyond the question count', () => {
    const paired = pairQuestionsWithAnswers([{ question: 'A' }], ['1', '2'])
    assert.deepEqual(paired, [{ question: 'A', answer: '1' }])
  })
})
