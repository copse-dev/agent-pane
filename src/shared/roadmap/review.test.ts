import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isReviewStale } from './review.ts'

describe('isReviewStale', () => {
  const checkpoint = {
    lastAcknowledgedBulkRun: 'run-1',
    pendingBulkRun: null as string | null,
  }

  it('is false for done or archived items', () => {
    assert.equal(
      isReviewStale({ reviewVerdict: 'open', reviewBulkRun: 'old' }, 'done', checkpoint),
      false,
    )
    assert.equal(
      isReviewStale({ reviewVerdict: 'open', reviewBulkRun: 'old' }, 'archived', checkpoint),
      false,
    )
  })

  it('is true without a verdict or bulk run id', () => {
    assert.equal(isReviewStale({}, 'ready', checkpoint), true)
    assert.equal(isReviewStale({ reviewVerdict: 'likely' }, 'ready', checkpoint), true)
  })

  it('keeps a deep review fresh without a bulk run id', () => {
    assert.equal(
      isReviewStale({ reviewVerdict: 'partial', reviewDepth: 'deep' }, 'ready', checkpoint),
      false,
    )
  })

  it('is false when the item matches the acknowledged bulk run', () => {
    assert.equal(
      isReviewStale({ reviewVerdict: 'likely', reviewBulkRun: 'run-1' }, 'ready', checkpoint),
      false,
    )
  })

  it('is false for an unacknowledged in-flight bulk run', () => {
    assert.equal(
      isReviewStale({ reviewVerdict: 'likely', reviewBulkRun: 'run-2' }, 'ready', {
        lastAcknowledgedBulkRun: 'run-1',
        pendingBulkRun: 'run-2',
      }),
      false,
    )
  })

  it('is true when the verdict is from an older acknowledged pass', () => {
    assert.equal(
      isReviewStale({ reviewVerdict: 'likely', reviewBulkRun: 'run-0' }, 'ready', checkpoint),
      true,
    )
  })
})
