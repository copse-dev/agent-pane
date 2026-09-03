import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFERRED_APPROVAL_SCHEMA_VERSION,
  DeferredApprovalError,
  deferredApprovalMessage,
  deferredRequestKey,
  foldDeferredApprovals,
  isDeferredApproval,
  isDeferredApprovalError,
  parseDeferredApprovals,
  pendingDeferrals,
  serializeDeferredApprovals,
  type DeferredApproval,
  type DeferredApprovalInput,
} from './deferred-approval.ts'

const input: DeferredApprovalInput = {
  threadId: 'thread-1',
  kind: 'shell',
  title: 'Run outside sandbox?',
  subject: 'shell command (arguments omitted)',
  cause: 'shell-sandbox-escalation',
  reasons: ['git network operation'],
  scope: 'external',
}

function entry(overrides: Partial<DeferredApproval> = {}): DeferredApproval {
  return {
    v: DEFERRED_APPROVAL_SCHEMA_VERSION,
    id: 'id-1',
    at: 1,
    status: 'pending',
    threadId: 'thread-1',
    kind: 'shell',
    title: 'Run outside sandbox?',
    subject: 'shell command (arguments omitted)',
    ...overrides,
  }
}

describe('deferredApprovalMessage', () => {
  const message = deferredApprovalMessage({ title: 'Run outside sandbox?', reasons: ['git push'] })

  it('says plainly that the action did not run', () => {
    assert.match(message, /not run/i)
    assert.match(message, /NOT run/)
  })

  it('names what was queued, and why', () => {
    assert.match(message, /Run outside sandbox\?/)
    assert.match(message, /git push/)
  })

  it('redirects rather than inviting a retry — the loop risk this wording exists to avoid', () => {
    assert.match(message, /continue with the other parts/i)
    assert.match(message, /Do not retry/i)
    // Must not read as failure-worth-retrying, nor as success.
    assert.doesNotMatch(message, /try again/i)
    assert.doesNotMatch(message, /\bdone\b/i)
    assert.doesNotMatch(message, /succeeded/i)
  })

  it('omits the parenthetical when there are no reasons', () => {
    const bare = deferredApprovalMessage({ title: 'Allow web origin?' })
    assert.match(bare, /Allow web origin\?\. /)
  })
})

describe('DeferredApprovalError', () => {
  it('carries the queue id and is recognisable by predicate', () => {
    const error = new DeferredApprovalError('id-9', 'queued')
    assert.equal(error.deferralId, 'id-9')
    assert.equal(error.name, 'DeferredApprovalError')
    assert.equal(isDeferredApprovalError(error), true)
    assert.equal(error instanceof Error, true)
  })

  it('rejects other errors and non-errors', () => {
    for (const value of [new Error('nope'), undefined, null, 'DeferredApprovalError', {}]) {
      assert.equal(isDeferredApprovalError(value), false)
    }
  })
})

describe('deferredRequestKey', () => {
  it('matches a repeat of the same request, so one question makes one entry', () => {
    assert.equal(deferredRequestKey(input), deferredRequestKey({ ...input }))
  })

  it('separates different subjects, scopes, causes, and threads', () => {
    const base = deferredRequestKey(input)
    assert.notEqual(base, deferredRequestKey({ ...input, subject: 'other' }))
    assert.notEqual(base, deferredRequestKey({ ...input, scope: 'sandbox' }))
    assert.notEqual(base, deferredRequestKey({ ...input, cause: 'shell-in-sandbox' }))
    assert.notEqual(base, deferredRequestKey({ ...input, threadId: 'thread-2' }))
  })

  it('ignores when it happened — identity is the request, not the moment', () => {
    const a = deferredRequestKey({ ...input })
    const b = deferredRequestKey({ ...input })
    assert.equal(a, b)
  })
})

describe('isDeferredApproval', () => {
  it('accepts a well-formed entry, with and without optionals', () => {
    assert.equal(isDeferredApproval(entry()), true)
    assert.equal(
      isDeferredApproval(
        entry({ turnId: 't1', cause: 'web-origin', reasons: ['x'], scope: 'external' }),
      ),
      true,
    )
  })

  it('rejects a wrong version, so a future shape cannot be half-read', () => {
    assert.equal(isDeferredApproval({ ...entry(), v: 2 }), false)
  })

  it('rejects bad status, bad cause, and non-records', () => {
    assert.equal(isDeferredApproval({ ...entry(), status: 'queued' }), false)
    assert.equal(isDeferredApproval({ ...entry(), cause: 'not-a-cause' }), false)
    for (const value of [null, undefined, 'x', 42, []]) {
      assert.equal(isDeferredApproval(value), false)
    }
  })
})

describe('queue folding', () => {
  it('lets a later write supersede an earlier one for the same id', () => {
    const folded = foldDeferredApprovals([
      entry({ id: 'a', at: 1 }),
      entry({ id: 'a', at: 1, status: 'approved', resolvedAt: 5 }),
    ])
    assert.equal(folded.length, 1)
    assert.equal(folded[0]?.status, 'approved')
  })

  it('keeps only outstanding entries in the pending view', () => {
    const pending = pendingDeferrals([
      entry({ id: 'a', at: 1 }),
      entry({ id: 'b', at: 2, status: 'rejected' }),
      entry({ id: 'c', at: 3 }),
    ])
    assert.deepEqual(
      pending.map((item) => item.id),
      ['a', 'c'],
    )
  })

  it('orders by time then id, so equal timestamps never reshuffle', () => {
    const folded = foldDeferredApprovals([
      entry({ id: 'b', at: 5 }),
      entry({ id: 'a', at: 5 }),
      entry({ id: 'c', at: 1 }),
    ])
    assert.deepEqual(
      folded.map((item) => item.id),
      ['c', 'a', 'b'],
    )
  })
})

describe('serialization', () => {
  it('round-trips through the queue file format', () => {
    const entries = [entry({ id: 'a' }), entry({ id: 'b', status: 'approved', resolvedAt: 9 })]
    assert.deepEqual(parseDeferredApprovals(serializeDeferredApprovals(entries)), entries)
  })

  it('skips blank and malformed lines rather than losing the file', () => {
    const raw = ['', 'not json', JSON.stringify(entry({ id: 'ok' })), '{"v":1}'].join('\n')
    const parsed = parseDeferredApprovals(raw)
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0]?.id, 'ok')
  })

  it('serializes an empty queue as an empty string', () => {
    assert.equal(serializeDeferredApprovals([]), '')
  })
})
