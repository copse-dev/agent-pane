import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanNextStep, mockNextStepHint } from './next-step-service.ts'

// The pure output cleaner — the LLM call itself is not driven here, matching
// follow-up-service.test.ts (provider resolution needs live settings/servers).

describe('cleanNextStep', () => {
  it('passes a plain instruction through, dropping a trailing period', () => {
    assert.equal(
      cleanNextStep('Run the tests to verify the fix.'),
      'Run the tests to verify the fix',
    )
  })

  it('strips wrapping quotes, backticks, and list markers', () => {
    assert.equal(cleanNextStep('"Commit these changes"'), 'Commit these changes')
    assert.equal(cleanNextStep('`Run pnpm test`'), 'Run pnpm test')
    assert.equal(cleanNextStep('- Run the linter'), 'Run the linter')
    assert.equal(cleanNextStep('1. Run the linter'), 'Run the linter')
  })

  it('takes the first substantive line of chatty output', () => {
    assert.equal(
      cleanNextStep('\n\nRun the tests\nBecause the fix touched the parser.'),
      'Run the tests',
    )
  })

  it('skips code-fence lines rather than suggesting them', () => {
    assert.equal(cleanNextStep('```\nRun the tests\n```'), 'Run the tests')
  })

  it('returns null when the model declines', () => {
    assert.equal(cleanNextStep('NONE'), null)
    assert.equal(cleanNextStep('none.'), null)
    assert.equal(cleanNextStep('Nothing comes to mind'), null)
    assert.equal(cleanNextStep('No next step is obvious here'), null)
  })

  it('returns null for empty or whitespace output', () => {
    assert.equal(cleanNextStep(''), null)
    assert.equal(cleanNextStep('   \n  '), null)
    assert.equal(cleanNextStep('""'), null)
  })

  it('rejects a rambling suggestion instead of truncating it', () => {
    const long = 'Review the changes and then consider whether the '.repeat(4)
    assert.equal(cleanNextStep(long), null)
  })
})

describe('mockNextStepHint', () => {
  it('is itself a valid hint, so the e2e fixture exercises the real path', () => {
    assert.equal(cleanNextStep(mockNextStepHint()), mockNextStepHint())
  })
})
