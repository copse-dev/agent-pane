import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDoctrineEvalArms,
  buildDoctrineEvalPrompt,
  parseDoctrineEvalArgs,
  renderDoctrineEvalMarkdown,
  summarizeDoctrineEval,
  type DoctrineEvalAttempt,
} from './doctrine-eval-lib.mts'

function attempt(
  armId: string,
  solved: boolean,
  doctrinePass: boolean,
  inputTokens: number,
  outputTokens: number,
): DoctrineEvalAttempt {
  return {
    taskId: 'task',
    armId,
    omit: armId === 'full' ? [] : ['tools'],
    attempt: 1,
    solved,
    gradeDetail: 'fixture',
    doctrine: {
      pass: doctrinePass,
      violations: doctrinePass ? [] : ['leadWithOutcome'],
      results: [
        {
          id: 'leadWithOutcome',
          pass: doctrinePass,
          detail: doctrinePass ? 'pass' : 'fail',
        },
        { id: 'readableOverTerse', pass: true, detail: 'pass' },
        { id: 'questionVsRequest', pass: true, detail: 'pass' },
        { id: 'faithfulReporting', pass: true, detail: 'pass' },
        { id: 'scopeDiscipline', pass: true, detail: 'pass' },
        { id: 'noNarratingComments', pass: true, detail: 'pass' },
      ],
    },
    toolCalls: [],
    finalMessage: 'The fixture completed successfully.',
    inputTokens,
    outputTokens,
    usageEstimated: false,
    durationMs: 10,
    trace: 'trace.jsonl',
  }
}

describe('doctrine eval prompt arms', () => {
  it('omits only the requested prompt section', () => {
    const full = buildDoctrineEvalPrompt('/tmp/workspace', [])
    const withoutTools = buildDoctrineEvalPrompt('/tmp/workspace', ['tools'])
    assert.match(full, /Available tools:/)
    assert.match(full, /Working style:/)
    assert.match(full, /Working directory: \/tmp\/workspace/)
    assert.doesNotMatch(withoutTools, /Available tools:/)
    assert.match(withoutTools, /Working style:/)
  })

  it('always includes a full control arm', () => {
    assert.deepEqual(buildDoctrineEvalArms(['tools', 'workingStyle']), [
      { id: 'full', omit: [] },
      { id: 'omit-tools', omit: ['tools'] },
      { id: 'omit-workingStyle', omit: ['workingStyle'] },
    ])
  })
})

describe('doctrine eval reporting', () => {
  it('reports rates, per-rule rates, and deltas against full', () => {
    const arms = buildDoctrineEvalArms(['tools'])
    const summaries = summarizeDoctrineEval(arms, [
      attempt('full', true, true, 100, 20),
      attempt('full', true, true, 120, 20),
      attempt('omit-tools', true, false, 80, 20),
      attempt('omit-tools', false, false, 80, 20),
    ])
    const full = summaries[0]
    const omitted = summaries[1]
    assert.ok(full)
    assert.ok(omitted)
    assert.equal(full.solveRate, 1)
    assert.equal(full.tokensPerSolve, 130)
    assert.equal(omitted.solveRate, 0.5)
    assert.equal(omitted.doctrinePassRate, 0)
    assert.equal(omitted.solveRateDeltaVsFull, -0.5)
    assert.equal(omitted.perRulePassRate.leadWithOutcome, 0)
  })

  it('renders a compact markdown matrix', () => {
    const arms = buildDoctrineEvalArms(['tools'])
    const attempts = [
      attempt('full', true, true, 100, 20),
      attempt('omit-tools', false, false, 80, 20),
    ]
    const markdown = renderDoctrineEvalMarkdown({
      schemaVersion: 1,
      generatedAt: '2026-07-30T00:00:00.000Z',
      provider: 'mock',
      model: 'mock',
      repeats: 1,
      taskIds: ['task'],
      arms: summarizeDoctrineEval(arms, attempts),
      attempts,
    })
    assert.match(markdown, /\| omit-tools \|/)
    assert.match(markdown, /-100\.0pp/)
    assert.match(markdown, /Per-rule pass rates/)
  })
})

describe('doctrine eval CLI parsing', () => {
  it('parses provider, repeats, and comma-separated sections', () => {
    const options = parseDoctrineEvalArgs([
      '--provider',
      'openai',
      '--model',
      'gpt-test',
      '--repeats',
      '5',
      '--sections',
      'tools,workingStyle',
      '--out',
      '/tmp/doctrine-report',
    ])
    assert.equal(options.providerId, 'openai')
    assert.equal(options.model, 'gpt-test')
    assert.equal(options.repeats, 5)
    assert.deepEqual(options.sections, ['tools', 'workingStyle'])
    assert.equal(options.outDir, '/tmp/doctrine-report')
    assert.equal(options.requireSolved, false)
    assert.equal(options.requireDoctrine, false)
  })

  it('rejects an unknown prompt section', () => {
    assert.throws(
      () => parseDoctrineEvalArgs(['--sections', 'not-a-section']),
      /Unknown prompt section/,
    )
  })
})
