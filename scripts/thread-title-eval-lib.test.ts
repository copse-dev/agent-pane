import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ThreadTitleEvalCase } from '../benchmarks/thread-titles/cases.ts'
import {
  parseThreadTitleEvalArgs,
  scoreThreadTitle,
  summarizeThreadTitleEval,
  type ThreadTitleEvalAttempt,
} from './thread-title-eval-lib.mts'

const CASE: ThreadTitleEvalCase = {
  id: 'thread-title',
  input: 'Improve thread naming',
  concepts: [['thread'], ['title', 'naming']],
}

describe('scoreThreadTitle', () => {
  it('requires both compact formatting and semantic coverage', () => {
    assert.deepEqual(scoreThreadTitle(CASE, 'Improve thread naming'), {
      pass: true,
      formatPass: true,
      conceptPass: true,
      missingConcepts: [],
    })

    const copiedOpening = scoreThreadTitle(CASE, 'Can we improve this?')
    assert.equal(copiedOpening.formatPass, false)
    assert.equal(copiedOpening.conceptPass, false)
    assert.equal(copiedOpening.pass, false)
  })
})

describe('summarizeThreadTitleEval', () => {
  it('reports product and raw-format rates independently', () => {
    const passing = scoreThreadTitle(CASE, 'Improve thread naming')
    const attempts: ThreadTitleEvalAttempt[] = [
      {
        caseId: CASE.id,
        arm: 'legacy',
        repeat: 1,
        raw: '**Improve thread naming**',
        title: 'Improve thread naming',
        rawFormatPass: false,
        score: passing,
        usage: { inputTokens: 10, outputTokens: 3 },
        durationMs: 5,
      },
      {
        caseId: CASE.id,
        arm: 'candidate',
        repeat: 1,
        raw: 'Improve thread naming',
        title: 'Improve thread naming',
        rawFormatPass: true,
        score: passing,
        usage: { inputTokens: 12, outputTokens: 3 },
        durationMs: 4,
      },
    ]

    const [legacy, candidate] = summarizeThreadTitleEval(['legacy', 'candidate'], attempts)
    assert.ok(legacy)
    assert.ok(candidate)
    assert.equal(legacy.passRate, 1)
    assert.equal(legacy.rawFormatPassRate, 0)
    assert.equal(candidate.rawFormatPassRate, 1)
  })
})

describe('parseThreadTitleEvalArgs', () => {
  it('accepts focused case and arm selections', () => {
    const options = parseThreadTitleEvalArgs([
      '--model',
      'local-model',
      '--case',
      'thread-title',
      '--arms',
      'candidate',
      '--repeats',
      '2',
    ])

    assert.equal(options.model, 'local-model')
    assert.equal(options.caseId, 'thread-title')
    assert.deepEqual(options.arms, ['candidate'])
    assert.equal(options.repeats, 2)
  })
})
