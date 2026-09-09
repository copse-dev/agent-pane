import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parsePrActivity } from './pr-activity.ts'

function fixture(): object {
  return {
    repository: {
      pullRequest: {
        headRefOid: 'abc1234',
        comments: {
          pageInfo: { hasPreviousPage: true },
          nodes: [
            {
              id: 'comment',
              body: 'Thanks',
              author: null,
              createdAt: '2026-09-09T10:00:00Z',
              url: 'https://github.com/comment',
            },
          ],
        },
        reviews: {
          pageInfo: { hasPreviousPage: false },
          nodes: [
            {
              id: 'review',
              body: '',
              author: { login: 'reviewer' },
              createdAt: '2026-09-09T09:00:00Z',
              url: 'https://github.com/review',
              state: 'APPROVED',
            },
            {
              id: 'draft',
              body: 'Private draft',
              author: { login: 'reviewer' },
              createdAt: null,
              url: 'https://github.com/draft',
              state: 'PENDING',
            },
          ],
        },
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    pageInfo: { hasNextPage: true },
                    nodes: [
                      {
                        name: 'Test',
                        status: 'COMPLETED',
                        conclusion: 'FAILURE',
                        detailsUrl: 'https://ci.example/test',
                      },
                      { name: 'Build', status: 'IN_PROGRESS', conclusion: null, detailsUrl: null },
                      {
                        context: 'Legacy CI',
                        state: 'PENDING',
                        targetUrl: 'https://ci.example/legacy',
                      },
                      {
                        name: 'Cancelled',
                        status: 'COMPLETED',
                        conclusion: 'CANCELLED',
                        detailsUrl: null,
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    },
  }
}

describe('PR activity mapping shared by CLI and API', () => {
  it('orders comments and reviews, retains empty approvals, and excludes unsubmitted reviews', () => {
    const activity = parsePrActivity(fixture())
    assert.equal(activity.error, undefined)
    assert.deepEqual(
      activity.comments.map((comment) => comment.id),
      ['review', 'comment'],
    )
    assert.equal(activity.comments[0]?.reviewState, 'APPROVED')
    assert.equal(activity.comments[1]?.author, 'ghost')
    assert.equal(activity.commentsTruncated, true)
  })

  it('keeps simultaneous failure and running statuses, legacy contexts, and cancellation', () => {
    const activity = parsePrActivity(fixture())
    assert.deepEqual(
      activity.checks.map((check) => check.state),
      ['FAILURE', 'IN_PROGRESS', 'PENDING', 'CANCELLED'],
    )
    assert.equal(activity.checks[2]?.url, 'https://ci.example/legacy')
    assert.equal(activity.checksTruncated, true)
    assert.equal(activity.headSha, 'abc1234')
  })

  it('does not mistake a missing or malformed API response for empty results', () => {
    for (const response of [
      null,
      {},
      { repository: null },
      { repository: { pullRequest: null } },
    ]) {
      assert.match(parsePrActivity(response).error ?? '', /Could not load/)
    }
  })
})
