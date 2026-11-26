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
        reviewThreads: {
          pageInfo: { hasNextPage: true },
          nodes: [
            {
              id: 'thread-open',
              path: 'src/a.ts',
              line: 12,
              isResolved: false,
              isOutdated: false,
              comments: {
                totalCount: 3,
                nodes: [
                  {
                    id: 'tc-1',
                    body: 'Handle null here',
                    author: { login: 'reviewer' },
                    createdAt: '2026-09-09T11:00:00Z',
                    url: 'https://github.com/tc-1',
                  },
                  {
                    id: 'tc-2',
                    body: 'Done',
                    author: null,
                    createdAt: '2026-09-09T11:05:00Z',
                    url: 'https://github.com/tc-2',
                  },
                ],
              },
            },
            {
              id: 'thread-outdated',
              path: 'src/b.ts',
              line: null,
              isResolved: true,
              isOutdated: true,
              comments: {
                totalCount: 1,
                nodes: [
                  {
                    id: 'tc-3',
                    body: 'Rename',
                    author: { login: 'reviewer' },
                    createdAt: '2026-09-09T11:10:00Z',
                    url: 'https://github.com/tc-3',
                  },
                ],
              },
            },
            {
              id: 'thread-empty',
              path: 'src/c.ts',
              line: 3,
              isResolved: false,
              isOutdated: false,
              comments: { totalCount: 0, nodes: [] },
            },
            null,
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

  it('maps inline review threads, keeps outdated ones, drops empty ones, and reports truncation', () => {
    const activity = parsePrActivity(fixture())
    assert.deepEqual(
      activity.reviewThreads.map((thread) => [thread.id, thread.line, thread.isResolved]),
      [
        ['thread-open', 12, false],
        ['thread-outdated', null, true],
      ],
    )
    const [open, outdated] = activity.reviewThreads
    assert.ok(open && outdated)
    assert.deepEqual(
      open.comments.map((comment) => comment.author),
      ['reviewer', 'ghost'],
    )
    assert.equal(open.commentsTruncated, true)
    assert.equal(outdated.commentsTruncated, false)
    assert.equal(activity.reviewThreadsTruncated, true)
    // Thread comments are not part of the top-level conversation.
    assert.ok(!activity.comments.some((comment) => comment.id.startsWith('tc-')))
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
