import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ClassifierAnswer, ClassifierRequest } from '@copse/llm/classifiers/types.ts'
import { MODEL_FOLLOW_UP_PRESETS } from '@shared/follow-ups/presets.ts'
import {
  CATEGORY_CASES,
  COMPLEXITY_CASES,
  COVERAGE_ISSUES,
  COVERAGE_ROADMAP,
  FIT_CASES,
  FOLLOW_UP_CASES,
  REVIEW_CASES,
} from '../benchmarks/background-questions/cases.ts'
import {
  BACKGROUND_QUESTIONS,
  classifierFixtures,
  parseBackgroundQuestionEvalArgs,
  renderReport,
  runBackgroundQuestionEval,
  scoreFollowUps,
  type ClassifierInvoker,
  type ModelInvoker,
} from './background-question-eval-lib.mts'

function uniqueIds(ids: readonly string[]): boolean {
  return new Set(ids).size === ids.length
}

const requestKey = (request: ClassifierRequest): string =>
  JSON.stringify([request.state, request.questions])

/** A classifier that answers every captured request with its labels, fully confident. */
async function perfectClassifier(): Promise<ClassifierInvoker> {
  const expectedByRequest = new Map<string, Record<string, unknown>>()
  for (const lines of (await classifierFixtures(BACKGROUND_QUESTIONS)).values()) {
    for (const line of lines) expectedByRequest.set(requestKey(line), line.expected ?? {})
  }
  return async (requests) =>
    requests.map((request) => {
      const expected = expectedByRequest.get(requestKey(request)) ?? {}
      const answers: Record<string, ClassifierAnswer> = {}
      for (const [id, question] of Object.entries(request.questions)) {
        if (question.type === 'boolean') {
          answers[id] = {
            type: 'boolean',
            probability: expected[id] === true ? 1 : 0,
          }
        } else if (question.type === 'choice') {
          const want = expected[id]
          answers[id] = {
            type: 'choice',
            choice: typeof want === 'string' ? want : '',
            probabilities: Object.fromEntries(
              Object.keys(question.options).map((option) => [option, option === want ? 1 : 0]),
            ),
          }
        }
      }
      return {
        profileId: 'fixture',
        adapter: 'systemone',
        requestedModel: 'fixture',
        model: 'fixture',
        elapsedMs: 1,
        answers,
        usage: { inputTokens: 10, outputTokens: 1 },
      }
    })
}

function replying(text: string): ModelInvoker {
  return async () => ({ text, usage: { inputTokens: 5, outputTokens: 1 } })
}

describe('background question cases', () => {
  it('have unique ids and balanced labels', () => {
    for (const cases of [COMPLEXITY_CASES, CATEGORY_CASES, FIT_CASES, REVIEW_CASES]) {
      assert.ok(uniqueIds(cases.map((c) => c.id)))
      const counts = new Map<string, number>()
      for (const c of cases) counts.set(c.expected, (counts.get(c.expected) ?? 0) + 1)
      assert.ok(Math.min(...counts.values()) >= 3, JSON.stringify([...counts]))
    }
    assert.ok(uniqueIds(FOLLOW_UP_CASES.map((c) => c.id)))
    assert.ok(uniqueIds(COVERAGE_ISSUES.map((i) => String(i.number))))
    assert.ok(uniqueIds(COVERAGE_ROADMAP.map((item) => item.id)))
  })

  it('name only roadmap items and presets that exist', () => {
    const items = new Set(COVERAGE_ROADMAP.map((item) => item.id))
    for (const issue of COVERAGE_ISSUES) {
      if (issue.expected) assert.ok(items.has(issue.expected.itemId), issue.expected.itemId)
    }
    const presets = new Set(MODEL_FOLLOW_UP_PRESETS.map((p) => p.id))
    for (const c of FOLLOW_UP_CASES) {
      for (const id of [...c.required, ...(c.allowed ?? [])]) assert.ok(presets.has(id), id)
      assert.ok(!c.required.some((id) => c.allowed?.includes(id)), c.id)
    }
  })
})

describe('classifierFixtures', () => {
  it('captures one schema-valid request per case, each with its labels', async () => {
    const fixtures = await classifierFixtures(BACKGROUND_QUESTIONS)
    assert.equal(fixtures.get('complexity')?.length, COMPLEXITY_CASES.length)
    assert.equal(fixtures.get('coverage')?.length, COVERAGE_ISSUES.length)
    assert.equal(fixtures.get('follow-ups')?.length, FOLLOW_UP_CASES.length)
    for (const lines of fixtures.values()) {
      for (const line of lines) assert.ok(line.expected, line.id)
    }
    const coverage = fixtures.get('coverage')?.[0]
    assert.equal(coverage?.id, 'coverage/#101')
    assert.equal(coverage.expected?.['item-1'], 'likely')
  })
})

describe('runBackgroundQuestionEval', () => {
  it('scores a classifier that answers every label correctly as perfect', async () => {
    const run = await runBackgroundQuestionEval({
      questions: BACKGROUND_QUESTIONS,
      arms: ['classifier'],
      repeats: 1,
      classifier: await perfectClassifier(),
    })
    for (const summary of run.summaries) {
      assert.equal(summary.correct, summary.attempts, summary.question)
      assert.equal(summary.costly, 0)
      assert.equal(summary.errors, 0)
    }
    const coverage = run.summaries.find((s) => s.question === 'coverage')
    assert.equal(coverage?.inputTokens, 10 * COVERAGE_ISSUES.length)
  })

  it('scores a model that never answers as unanswered, not wrong in its own way', async () => {
    const run = await runBackgroundQuestionEval({
      questions: BACKGROUND_QUESTIONS,
      arms: ['model'],
      repeats: 1,
      model: replying('I am not sure.'),
    })
    const summary = (question: string): (typeof run.summaries)[number] | undefined =>
      run.summaries.find((s) => s.question === question)
    assert.equal(summary('complexity')?.answered, 0)
    assert.equal(summary('complexity')?.errors, COMPLEXITY_CASES.length)
    assert.deepEqual(summary('complexity')?.confusion?.['low'], { '(none)': 8 })
    // Coverage and follow-ups read no lines as "nothing matches", as the product does.
    assert.equal(summary('coverage')?.correct, COVERAGE_ISSUES.filter((i) => !i.expected).length)
    assert.equal(
      summary('follow-ups')?.correct,
      FOLLOW_UP_CASES.filter((c) => c.required.length === 0).length,
    )
  })

  it('counts a hopeful verdict on the wrong case as costly', async () => {
    const fit = await runBackgroundQuestionEval({
      questions: ['fit'],
      arms: ['model'],
      repeats: 1,
      model: replying('likely\n- looks fine'),
    })
    assert.equal(fit.summaries[0]?.costly, FIT_CASES.filter((c) => c.expected !== 'likely').length)
    const review = await runBackgroundQuestionEval({
      questions: ['review'],
      arms: ['model'],
      repeats: 2,
      model: replying('resolved'),
    })
    assert.equal(
      review.summaries[0]?.costly,
      2 * REVIEW_CASES.filter((c) => c.expected !== 'resolved').length,
    )
  })

  it('records a failed classifier call as an error with no answer', async () => {
    const run = await runBackgroundQuestionEval({
      questions: ['fit'],
      arms: ['classifier'],
      repeats: 1,
      classifier: async () => {
        throw new Error('connection refused')
      },
    })
    assert.equal(run.summaries[0]?.answered, 0)
    assert.equal(run.calls[0]?.error, 'connection refused')
  })
})

describe('scoreFollowUps', () => {
  it('needs every required preset and nothing outside the allowed ones', () => {
    assert.deepEqual(scoreFollowUps(['run-tests'], ['explain'], 'explain,run-tests'), {
      correct: true,
      missed: [],
      unwanted: [],
    })
    assert.deepEqual(scoreFollowUps(['run-tests'], [], 'continue'), {
      correct: false,
      missed: ['run-tests'],
      unwanted: ['continue'],
    })
    assert.equal(scoreFollowUps([], [], '(none)').correct, true)
    assert.equal(scoreFollowUps([], [], null).correct, false)
  })
})

describe('parseBackgroundQuestionEvalArgs', () => {
  it('runs the model arm on every question by default and skips the pnpm separator', () => {
    const options = parseBackgroundQuestionEvalArgs(['--', '--repeats', '3'])
    assert.deepEqual(options.questions, [...BACKGROUND_QUESTIONS])
    assert.deepEqual(options.arms, ['model'])
    assert.equal(options.repeats, 3)
    assert.equal(options.dryRun, false)
  })

  it('adds the classifier arm when a classifier is configured', () => {
    const options = parseBackgroundQuestionEvalArgs([
      '--classifier-config',
      'benchmarks/classifiers/kev.json',
      '--questions',
      'fit,review',
      '--dry-run',
    ])
    assert.deepEqual(options.arms, ['classifier', 'model'])
    assert.deepEqual(options.questions, ['fit', 'review'])
    assert.equal(options.dryRun, true)
  })

  it('rejects unknown questions, a classifier arm with no classifier and stray flags', () => {
    assert.throws(() => parseBackgroundQuestionEvalArgs(['--questions', 'titles']), /--questions/)
    assert.throws(
      () => parseBackgroundQuestionEvalArgs(['--arms', 'classifier']),
      /--classifier-config/,
    )
    assert.throws(() => parseBackgroundQuestionEvalArgs(['--repeat', '2']), /Unknown/)
    assert.throws(() => parseBackgroundQuestionEvalArgs(['--repeats', '0']), /positive/)
  })
})

describe('renderReport', () => {
  it('lists each arm, a confusion matrix per label question, and the misses', async () => {
    const run = await runBackgroundQuestionEval({
      questions: ['complexity'],
      arms: ['model'],
      repeats: 1,
      model: replying('medium'),
    })
    const markdown = renderReport({
      schemaVersion: 1,
      generatedAt: '2026-09-30T00:00:00.000Z',
      classifier: null,
      model: 'fixture-model',
      repeats: 1,
      questions: ['complexity'],
      ...run,
    })
    assert.match(markdown, /\| complexity \| model \| 8\/24 \(33\.3%\) \| 100\.0% \|/)
    assert.match(markdown, /## complexity — model/)
    assert.match(markdown, /\| high \| 8 \|/)
    assert.match(markdown, /\| complexity \| rename-decision-label \| model \| low \| medium \|/)
  })
})
