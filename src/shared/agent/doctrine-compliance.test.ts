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

  it('does not treat a later successful rerun as an outstanding failure', () => {
    const report = scoreDoctrineCompliance({
      userMessage: 'Fix the failing test',
      userIntent: 'request',
      toolCalls: [
        {
          name: 'run_shell',
          args: { command: 'npm test' },
          result: 'exit=1\nFAIL src/a.test.ts',
        },
        { name: 'str_replace', args: { path: 'src/a.ts', new_string: 'fixed' } },
        {
          name: 'run_shell',
          args: { command: 'npm test' },
          result: 'exit=0\nall tests passed',
        },
      ],
      finalMessage: 'Fixed the defect in src/a.ts, and the test suite now passes.',
    })
    assert.equal(report.pass, true)
  })

  it('treats delete, rename, and directory creation as edits', () => {
    for (const toolCall of [
      { name: 'delete_file', args: { path: 'src/old.ts' } },
      { name: 'rename_file', args: { from: 'src/old.ts', to: 'src/new.ts' } },
      { name: 'make_directory', args: { path: 'src/generated' } },
    ]) {
      const report = scoreDoctrineCompliance({
        userMessage: 'What files are obsolete?',
        userIntent: 'question',
        toolCalls: [toolCall],
        finalMessage: 'The legacy helper is obsolete and can be removed safely.',
      })
      assert.ok(report.violations.includes('questionVsRequest'), toolCall.name)
    }
  })

  it('checks both sides of a rename against the requested scope', () => {
    const report = scoreDoctrineCompliance({
      userMessage: 'Rename the helper within src/core',
      userIntent: 'request',
      inScopePaths: ['src/core'],
      toolCalls: [
        {
          name: 'rename_file',
          args: { from: 'src/core/helper.ts', to: 'src/unrelated/helper.ts' },
        },
      ],
      finalMessage: 'Renamed the helper, but moved it outside the requested directory.',
    })
    assert.ok(report.violations.includes('scopeDiscipline'))
  })
})
