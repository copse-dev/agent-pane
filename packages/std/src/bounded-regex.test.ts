import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { matchingIndexesWithin, regexTestWithin } from './bounded-regex.ts'

describe('bounded-regex', () => {
  it('returns matching subject indexes up to the limit', () => {
    const subjects = ['alpha', 'beta', 'alphabet', 'gamma']
    assert.deepEqual(matchingIndexesWithin(/alph/, subjects, { timeoutMs: 1_000 }), [0, 2])
    assert.deepEqual(matchingIndexesWithin(/a/, subjects, { timeoutMs: 1_000, limit: 2 }), [0, 1])
    assert.equal(regexTestWithin(/^beta$/, 'beta', 1_000), true)
    assert.equal(regexTestWithin(/^beta$/, 'alpha', 1_000), false)
  })

  it('reports a timeout instead of hanging on catastrophic backtracking', () => {
    const started = Date.now()
    assert.equal(regexTestWithin(/^(a+)+$/, `${'a'.repeat(64)}!`, 50), 'timeout')
    assert.ok(Date.now() - started < 5_000)
    // The shared context is reusable after an interrupted run.
    assert.equal(regexTestWithin(/a/, 'a', 1_000), true)
  })

  it('propagates a non-timeout error', () => {
    const throwing = /x/
    throwing.test = (): boolean => {
      throw new Error('boom')
    }
    assert.throws(() => regexTestWithin(throwing, 'x', 1_000), /boom/)
  })
})
