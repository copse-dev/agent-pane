import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cachedDenialAdvice, deniedOperations } from './denied-operations.ts'

describe('deniedOperations (issue #1436 point 2)', () => {
  it('has no cached advice before anything was recorded', () => {
    assert.equal(cachedDenialAdvice('thread-fresh', 'git fetch'), null)
    assert.equal(deniedOperations.isDenied('thread-fresh', 'git fetch'), false)
  })

  it('returns cached advice for the exact operation recorded, naming it', () => {
    deniedOperations.record(
      'thread-a',
      'git fetch',
      'git fetch origin main',
      'git fetch needs network access that was denied',
    )
    const advice = cachedDenialAdvice('thread-a', 'git fetch')
    assert.ok(advice)
    assert.match(advice, /git fetch/)
    assert.match(advice, /git fetch origin main/)
  })

  it('a denied fetch does not make a later push look blocked (no network-wide warning)', () => {
    deniedOperations.record(
      'thread-b',
      'git fetch',
      'git fetch origin main',
      'git fetch needs network access that was denied',
    )
    // The push is a DIFFERENT operation over the same tool; it must read as
    // unknown, not as "the network is blocked" carried over from the fetch.
    assert.equal(cachedDenialAdvice('thread-b', 'git push'), null)
    assert.equal(deniedOperations.isDenied('thread-b', 'git push'), false)
    // The fetch itself is still remembered.
    assert.ok(cachedDenialAdvice('thread-b', 'git fetch'))
  })

  it('keeps threads independent: a denial in one thread is invisible to another', () => {
    deniedOperations.record(
      'thread-c1',
      'read ~/.config/gh',
      'gh pr create',
      'gh needs config access',
    )
    assert.equal(cachedDenialAdvice('thread-c2', 'read ~/.config/gh'), null)
  })

  it('treats the no-active-thread case as its own bucket, isolated from real threads', () => {
    deniedOperations.record(null, 'git fetch', 'git fetch origin main', 'denied')
    assert.equal(cachedDenialAdvice('thread-d', 'git fetch'), null)
    assert.ok(cachedDenialAdvice(null, 'git fetch'))
  })
})
