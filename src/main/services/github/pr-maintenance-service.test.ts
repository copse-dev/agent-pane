import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createPrMaintenanceService } from './pr-maintenance-service.ts'

const ref = { owner: 'copse-dev', repo: 'agent-pane', number: 7 }
const sha = 'a'.repeat(40)
type GhReply = { stdout: string; stderr: string; code: number }
const ok = (stdout = ''): GhReply => ({ stdout, stderr: '', code: 0 })

const other = 'b'.repeat(40)

function readiness(
  pr: {
    isDraft?: boolean
    headRefOid?: string
    reviewDecision?: string | null
    reviews?: { state: string; commit: { oid: string } | null }[]
  } = {},
): GhReply {
  return ok(
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            isDraft: pr.isDraft ?? false,
            headRefOid: pr.headRefOid ?? sha,
            reviewDecision: pr.reviewDecision ?? null,
            latestReviews: { nodes: pr.reviews ?? [{ state: 'APPROVED', commit: { oid: sha } }] },
          },
        },
      },
    }),
  )
}

function reviewThread(repo: string, number: number, isResolved = false): GhReply {
  return ok(
    JSON.stringify({
      data: {
        node: {
          __typename: 'PullRequestReviewThread',
          isResolved,
          pullRequest: { number, repository: { nameWithOwner: repo } },
        },
      },
    }),
  )
}

describe('PR maintenance actions', () => {
  it('uses repository merge policy and passes the exact head guard without admin bypass', async () => {
    const calls: string[][] = []
    const service = createPrMaintenanceService(async (args) => {
      calls.push(args)
      if (calls.length === 1) return readiness()
      return calls.length === 2
        ? ok(
            JSON.stringify({
              allow_squash_merge: true,
              allow_merge_commit: false,
              allow_rebase_merge: false,
            }),
          )
        : { stdout: '', stderr: 'Head changed', code: 1 }
    })
    assert.match(await service.merge(ref, sha), /Failed: Head changed/)
    assert.deepEqual(calls[2], [
      'pr',
      'merge',
      '-R',
      'copse-dev/agent-pane',
      '7',
      '--squash',
      '--match-head-commit',
      sha,
    ])
  })

  it('does not attempt a merge with missing review state, missing policy, or an invalid SHA', async () => {
    const calls: string[][] = []
    const service = createPrMaintenanceService(async (args) => {
      calls.push(args)
      return calls.length === 2 ? readiness() : ok('{}')
    })
    assert.match(await service.merge(ref, 'HEAD'), /^Failed:/)
    assert.equal(calls.length, 0)
    assert.match(await service.merge(ref, sha), /^Failed: could not read pull request review state/)
    assert.equal(calls.length, 1)
    assert.match(await service.merge(ref, sha), /^Failed: could not read repository merge policy/)
    assert.equal(calls.length, 3)
  })

  for (const { name, pr, reason } of [
    { name: 'a draft', pr: { isDraft: true }, reason: /draft/ },
    { name: 'a moved head', pr: { headRefOid: other }, reason: /head is now bbbbbbbbb/ },
    {
      name: 'an outstanding change request',
      pr: { reviewDecision: 'CHANGES_REQUESTED' },
      reason: /requested changes/,
    },
    { name: 'no review', pr: { reviews: [] }, reason: /no approving review/ },
    {
      name: 'an approval of an earlier commit',
      pr: { reviews: [{ state: 'APPROVED', commit: { oid: other } }] },
      reason: /no approving review/,
    },
    {
      name: 'only comment reviews',
      pr: { reviews: [{ state: 'COMMENTED', commit: { oid: sha } }] },
      reason: /no approving review/,
    },
  ]) {
    it(`refuses to merge ${name} before reading merge policy`, async () => {
      const calls: string[][] = []
      const service = createPrMaintenanceService(async (args) => {
        calls.push(args)
        return readiness(pr)
      })
      const outcome = await service.merge(ref, sha)
      assert.match(outcome, /^Failed: not merging PR #7: /)
      assert.match(outcome, reason)
      assert.equal(calls.length, 1, 'no policy read or merge after a refusal')
    })
  }

  it('passes multiline comments literally as one argument', async () => {
    const calls: string[][] = []
    const service = createPrMaintenanceService(async (args) => {
      calls.push(args)
      return ok()
    })
    const body = 'Verified fix.\n\n`$(false)` stays literal.'
    assert.match(await service.comment(ref, body), /Comment posted/)
    assert.deepEqual(calls[0], ['pr', 'comment', '-R', 'copse-dev/agent-pane', '7', '--body', body])
  })

  for (const { repo, number } of [
    { repo: 'elsewhere/repo', number: 7 },
    { repo: 'copse-dev/agent-pane', number: 8 },
  ]) {
    it(`refuses a review thread belonging to ${repo}#${String(number)}`, async () => {
      const calls: string[][] = []
      const service = createPrMaintenanceService(async (args) => {
        calls.push(args)
        return reviewThread(repo, number)
      })
      assert.match(await service.resolveReviewThread(ref, 'PRRT_id'), /does not belong/)
      assert.equal(calls.length, 1)
    })
  }

  it('resolves a matching review thread and reports transport failure', async () => {
    const calls: string[][] = []
    const service = createPrMaintenanceService(async (args) => {
      calls.push(args)
      return calls.length === 1
        ? reviewThread('copse-dev/agent-pane', 7)
        : { stdout: '', stderr: 'Not authorized', code: 1 }
    })
    assert.match(await service.resolveReviewThread(ref, 'PRRT_id'), /Failed: Not authorized/)
    assert.equal(calls.length, 2)
    assert.ok(calls[1]?.some((arg) => arg.includes('resolveReviewThread(input:')))
    assert.ok(calls[1]?.includes('id=PRRT_id'))
  })

  it('requires a confirmed mutation result and skips already resolved threads', async () => {
    for (const state of ['resolved', 'confirm', 'malformed']) {
      let calls = 0
      const service = createPrMaintenanceService(async () => {
        calls++
        if (calls === 1) return reviewThread('copse-dev/agent-pane', 7, state === 'resolved')
        return ok(
          state === 'confirm'
            ? JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } })
            : '{}',
        )
      })
      const message = await service.resolveReviewThread(ref, 'PRRT_id')
      if (state === 'resolved') {
        assert.equal(calls, 1)
        assert.match(message, /already resolved/)
      } else {
        assert.equal(calls, 2)
        assert.match(message, state === 'confirm' ? /^Resolved/ : /^Failed:/)
      }
    }
  })
})
