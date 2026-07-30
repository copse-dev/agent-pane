import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DOCTRINE_RULE_IDS,
  inferUserIntent,
  scoreDoctrineCompliance,
  type DoctrineTranscript,
} from './doctrine-compliance.ts'

describe('inferUserIntent', () => {
  it('classifies questions and requests', () => {
    assert.equal(inferUserIntent('What does this function return?'), 'question')
    assert.equal(inferUserIntent('How does the permission gate work?'), 'question')
    assert.equal(inferUserIntent('Fix the off-by-one in sum.js'), 'request')
    assert.equal(inferUserIntent('Can you implement retry for the flaky test?'), 'request')
    assert.equal(inferUserIntent(''), 'unknown')
  })
})

describe('scoreDoctrineCompliance', () => {
  it('passes a clean question answer', () => {
    const transcript: DoctrineTranscript = {
      userMessage: 'What is the default branch policy?',
      userIntent: 'question',
      toolCalls: [{ name: 'read_file', args: { path: 'src/main/services/agent-prompt.ts' } }],
      finalMessage:
        'Commits must stay off the default branch; Copse creates copse/<short-kebab-summary> when needed.',
    }
    const report = scoreDoctrineCompliance(transcript)
    assert.equal(report.pass, true)
    assert.deepEqual(report.violations, [])
    assert.equal(report.results.length, DOCTRINE_RULE_IDS.length)
  })

  it('flags a weak opener on the final message', () => {
    const report = scoreDoctrineCompliance({
      userMessage: 'What changed?',
      userIntent: 'question',
      toolCalls: [],
      finalMessage: 'Let me summarize the diff for you. The helper grew a null check.',
    })
    assert.equal(report.pass, false)
    assert.ok(report.violations.includes('leadWithOutcome'))
  })

  it('flags unfaithful success claims when tools failed', () => {
    const report = scoreDoctrineCompliance({
      userMessage: 'Run tests',
      userIntent: 'request',
      toolCalls: [
        {
          name: 'run_shell',
          args: { command: 'npm test' },
          result: 'exit=1\nFAIL src/a.test.ts',
        },
      ],
      finalMessage: 'Everything looks good and the suite is green.',
    })
    assert.ok(report.violations.includes('faithfulReporting'))
  })
})
