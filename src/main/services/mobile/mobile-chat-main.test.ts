import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { StoredThreadPlan } from '@copse/thread-store/plan-schema.ts'
import { admitReviewedMobilePlan } from './mobile-chat.ts'
import { mobilePlanAuthorityHash } from './mobile-plan-review.ts'

function plan(status: 'draft' | 'abandoned' = 'draft'): StoredThreadPlan {
  return {
    meta: {
      planId: 'plan-1',
      threadId: 'thread',
      title: 'Reviewed implementation',
      status,
      currentRevision: 3,
      createdAt: 1,
      updatedAt: 2,
    },
    body: '# Goal\n\nShip safely.',
    contentHash: 'a'.repeat(64),
    comments: [],
    approval: null,
    completion: null,
  }
}

function review(value: StoredThreadPlan): {
  planId: string
  revision: number
  contentHash: string
  authorityHash: string
} {
  return {
    planId: value.meta.planId,
    revision: value.meta.currentRevision,
    contentHash: value.contentHash,
    authorityHash: mobilePlanAuthorityHash(value),
  }
}

test('mobile plan authority requires the exact main-served revision reviewed by the phone', () => {
  const current = plan()
  const admitted = admitReviewedMobilePlan(current, review(current))
  assert.equal(admitted.ok, true)
  assert.deepEqual(admitted.plan, current)
  assert.notEqual(admitted.plan, current)
  assert.deepEqual(admitReviewedMobilePlan(null, undefined), { ok: true, plan: null })
  assert.deepEqual(admitReviewedMobilePlan(plan('abandoned'), undefined), { ok: true, plan: null })
})

test('mobile plan authority fails closed on missing, stale, substituted or unexpected review', () => {
  const current = plan()
  assert.deepEqual(admitReviewedMobilePlan(current, undefined), { ok: false })
  assert.deepEqual(
    admitReviewedMobilePlan(current, {
      ...review(current),
      planId: 'other',
    }),
    { ok: false },
  )
  assert.deepEqual(
    admitReviewedMobilePlan(current, {
      ...review(current),
      revision: 2,
    }),
    { ok: false },
  )
  assert.deepEqual(
    admitReviewedMobilePlan(current, {
      ...review(current),
      contentHash: 'b'.repeat(64),
    }),
    { ok: false },
  )
  assert.deepEqual(
    admitReviewedMobilePlan(null, {
      ...review(current),
    }),
    { ok: false },
  )
})

test('mobile plan authority rejects approval and comment changes after phone review', () => {
  const draft = plan()
  const reviewed = review(draft)
  const approved = structuredClone(draft)
  approved.meta.status = 'approved'
  approved.meta.updatedAt++
  approved.meta.approvedAt = 3
  approved.meta.approvedRevision = approved.meta.currentRevision
  approved.meta.executionProfileId = 'implementation'
  approved.meta.contentHash = approved.contentHash
  approved.approval = {
    planId: approved.meta.planId,
    approvedRevision: approved.meta.currentRevision,
    approvedAt: 3,
    executionProfileId: 'implementation',
    contentHash: approved.contentHash,
  }
  assert.deepEqual(admitReviewedMobilePlan(approved, reviewed), { ok: false })

  const commented = structuredClone(draft)
  commented.comments.push({
    id: 'comment-1',
    revision: draft.meta.currentRevision,
    body: 'Inject a different planning instruction.',
    createdAt: 3,
    author: 'user',
  })
  assert.deepEqual(admitReviewedMobilePlan(commented, reviewed), { ok: false })
})
