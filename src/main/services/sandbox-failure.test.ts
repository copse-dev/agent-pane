import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectSandboxFailure } from './sandbox-failure.ts'

describe('detectSandboxFailure', () => {
  it('returns false for successful commands even if violations were logged', () => {
    // exit 0 means it succeeded; never offer an unsandboxed escape.
    const r = detectSandboxFailure({ exitCode: 0, violationCount: 3 })
    assert.equal(r.likely, false)
  })

  it('returns false for ordinary non-zero exits with no runner violations', () => {
    const r = detectSandboxFailure({ exitCode: 1, violationCount: 0 })
    assert.equal(r.likely, false)
  })

  it('detects failure when the runner logged sandbox violations and exit is non-zero', () => {
    const r = detectSandboxFailure({ exitCode: 1, violationCount: 2 })
    assert.equal(r.likely, true)
    assert.ok(r.reasons.some((x) => x.includes('blocked 2 operations')))
  })

  it('reports a single blocked operation in the singular', () => {
    const r = detectSandboxFailure({ exitCode: 126, violationCount: 1 })
    assert.equal(r.likely, true)
    assert.ok(r.reasons.some((x) => x.includes('blocked 1 operation')))
  })

  it('detects wrapper spawn failures (runner-side)', () => {
    const r = detectSandboxFailure({ exitCode: -1, violationCount: 0, spawnFailed: true })
    assert.equal(r.likely, true)
    assert.ok(r.reasons.some((x) => x.includes('failed to start')))
  })

  it('ignores command-controlled output (issue #104): faked failure does not trigger', () => {
    // A command that echoes a sandbox-denial string but never actually tripped the
    // sandbox (violationCount 0, no spawn failure) must NOT be offered an unsandboxed
    // re-run. The decision keys only off runner-side signals, never stdout/stderr.
    const r = detectSandboxFailure({ exitCode: 1, violationCount: 0 })
    assert.equal(r.likely, false)
  })
})
