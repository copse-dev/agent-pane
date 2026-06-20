import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectLikelySandboxFailure } from './sandbox-failure.ts'

describe('detectLikelySandboxFailure', () => {
  it('returns false for successful commands', () => {
    const r = detectLikelySandboxFailure('all tests passed', 0)
    assert.equal(r.likely, false)
  })

  it('returns false for ordinary test failures', () => {
    const r = detectLikelySandboxFailure('AssertionError: expected true to be false', 1)
    assert.equal(r.likely, false)
  })

  it('detects macOS sandbox denial messages', () => {
    const r = detectLikelySandboxFailure('sh: Operation not permitted\n', 126)
    assert.equal(r.likely, true)
    assert.ok(r.reasons.some((x) => x.includes('sandbox denied')))
  })

  it('detects playwright launch failures as likely sandbox issues', () => {
    const output =
      'browserType.launch: Failed to launch chromium because Operation not permitted\n' +
      '  at playwright/lib/browserType.js:120'
    const r = detectLikelySandboxFailure(output, 1)
    assert.equal(r.likely, true)
    assert.ok(r.reasons.some((x) => x.includes('browser/test runner')))
  })

  it('detects network blocks', () => {
    const r = detectLikelySandboxFailure('Error: network access blocked by sandbox policy', 1)
    assert.equal(r.likely, true)
  })
})
