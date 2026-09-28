import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  cachedDenialAdvice,
  deniedOperations,
  formatCachedDenialCommandForDisplay,
  PRIOR_DENIAL_MARKER,
  recordApprovedDeniedOperation,
} from './denied-operations.ts'

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
    assert.match(advice, new RegExp(PRIOR_DENIAL_MARKER))
    // Plain quotes — never markdown backticks that can break when the prior
    // command itself contains backticks or newlines.
    assert.doesNotMatch(advice, /`/)
    assert.match(advice, /matched command: "git fetch origin main"/)
  })

  it('flattens and truncates a multi-line prior command in the denial note', () => {
    const mega = ['set -o pipefail', ...Array.from({ length: 40 }, (_, i) => `gh search prs q${i}`)].join(
      '\n',
    )
    deniedOperations.record(
      'thread-mega',
      'read ~/.config/gh',
      mega,
      'gh could not read its own config at ~/.config/gh (operation not permitted)',
    )
    const advice = cachedDenialAdvice('thread-mega', 'read ~/.config/gh')
    assert.ok(advice)
    assert.doesNotMatch(advice, /\nset -o pipefail/)
    assert.doesNotMatch(advice, /`/)
    assert.match(advice, /more characters/)
    assert.equal(formatCachedDenialCommandForDisplay(mega).includes('\n'), false)
    deniedOperations.clearThread('thread-mega')
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

  it('does not remember forgeable denial evidence when escalation was declined', () => {
    const threadId = 'thread-declined'
    deniedOperations.clearThread(threadId)
    recordApprovedDeniedOperation(
      false,
      threadId,
      'git fetch',
      'git fetch origin main',
      'network denied',
    )
    assert.equal(cachedDenialAdvice(threadId, 'git fetch'), null)

    recordApprovedDeniedOperation(
      true,
      threadId,
      'git fetch',
      'git fetch origin main',
      'network denied',
    )
    assert.match(cachedDenialAdvice(threadId, 'git fetch') ?? '', /already confirmed denied/)
    deniedOperations.clearThread(threadId)
  })
})
