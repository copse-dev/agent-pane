import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseTerminalReadVerdict, terminalReadNeedsApproval } from './terminal-read-verdict.ts'

describe('parseTerminalReadVerdict', () => {
  it('parses a well-formed verdict and clamps confidence', () => {
    assert.deepEqual(
      parseTerminalReadVerdict('{"risk":"risky","confidence":1.7,"reason":"env dump"}'),
      { risky: true, confidence: 1, reason: 'env dump' },
    )
    assert.deepEqual(
      parseTerminalReadVerdict('noise {"risk":"safe","confidence":0.9,"reason":"build log"}'),
      { risky: false, confidence: 0.9, reason: 'build log' },
    )
  })

  it('rejects unknown risk values, missing reasons, and non-JSON', () => {
    assert.equal(parseTerminalReadVerdict('{"risk":"fine","confidence":1,"reason":"x"}'), null)
    assert.equal(parseTerminalReadVerdict('{"risk":"safe","confidence":1,"reason":""}'), null)
    assert.equal(parseTerminalReadVerdict('not json'), null)
  })

  it('treats a malformed confidence as zero (escalates, never widens)', () => {
    const verdict = parseTerminalReadVerdict('{"risk":"safe","confidence":"high","reason":"x"}')
    assert.deepEqual(verdict, { risky: false, confidence: 0, reason: 'x' })
  })
})

describe('terminalReadNeedsApproval', () => {
  it('escalates when the classifier is unavailable or failed', () => {
    assert.equal(terminalReadNeedsApproval(null), true)
  })

  it('escalates any risky verdict regardless of confidence', () => {
    assert.equal(terminalReadNeedsApproval({ risky: true, confidence: 0.1, reason: 'x' }), true)
  })

  it('auto-allows only a reasonably confident safe verdict', () => {
    assert.equal(terminalReadNeedsApproval({ risky: false, confidence: 0.9, reason: 'x' }), false)
    assert.equal(terminalReadNeedsApproval({ risky: false, confidence: 0.3, reason: 'x' }), true)
  })
})
