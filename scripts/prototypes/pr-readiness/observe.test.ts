import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assessPrReadiness, type ReadinessSnapshot } from './model.mts'
import { at } from '@copse/std/array-utils.ts'
import { observePrReadiness, READINESS_QUERY } from './observe.mts'
import { Kind, OperationTypeNode, parse } from 'graphql'

const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const request = { repository: 'example/project', number: 7 }
const now = 1_000_000
const initialCheck = {
  __typename: 'CheckRun',
  id: 'check-10',
  databaseId: 10,
  name: 'CI Passed',
  status: 'COMPLETED',
  conclusion: 'SUCCESS',
  detailsUrl: 'https://example.test/check',
  isRequired: true,
  checkSuite: { id: 'suite-1', commit: { oid: head }, app: { id: 'app-1' } },
}
function check(id = 10, name = 'CI Passed'): typeof initialCheck {
  return { ...structuredClone(initialCheck), id: `check-${String(id)}`, databaseId: id, name }
}
const initialStatus = {
  __typename: 'StatusContext',
  id: 'status-1',
  context: 'CI Passed',
  state: 'SUCCESS',
  targetUrl: 'https://example.test/status',
  createdAt: '2026-11-07T01:00:00Z',
  commit: { oid: head },
  isRequired: true,
}
function status(): typeof initialStatus {
  return structuredClone(initialStatus)
}
const initialReply = {
  data: {
    repository: {
      nameWithOwner: 'example/project',
      pullRequest: {
        number: 7,
        url: 'https://github.com/example/project/pull/7',
        state: 'OPEN',
        isDraft: false,
        headRefOid: head,
        baseRefOid: base,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        reviewDecision: 'APPROVED',
        potentialMergeCommit: {
          oid: 'c'.repeat(40),
          statusCheckRollup: null as { state: string } | null,
        },
        latestReviews: {
          pageInfo: { hasNextPage: false },
          nodes: [{ state: 'APPROVED', commit: { oid: head } }],
        },
        reviewThreads: {
          pageInfo: { hasNextPage: false },
          nodes: [{ id: 'thread-1', isResolved: true }],
        },
        commits: {
          nodes: [
            {
              commit: {
                oid: head,
                statusCheckRollup: {
                  state: 'SUCCESS',
                  contexts: { pageInfo: { hasNextPage: false }, nodes: [check(), status()] },
                },
              },
            },
          ],
        },
      },
    },
  },
}
function fixture(): typeof initialReply {
  return structuredClone(initialReply)
}
const prOf = (data: typeof initialReply): typeof initialReply.data.repository.pullRequest =>
  data.data.repository.pullRequest
async function observe(data = fixture()): Promise<ReadinessSnapshot> {
  return observePrReadiness(
    request,
    async () => data,
    () => now,
  )
}

describe('bounded current-head GitHub observation', () => {
  it('queries only read operations and declares every connection limit', () => {
    const ast = parse(READINESS_QUERY)
    assert.ok(
      ast.definitions.every(
        (definition) =>
          definition.kind === Kind.OPERATION_DEFINITION &&
          definition.operation === OperationTypeNode.QUERY,
      ),
    )
    assert.match(READINESS_QUERY, /isRequired\(pullRequestNumber: \$number\)/)
    assert.equal((READINESS_QUERY.match(/hasNextPage/g) ?? []).length, 3)
  })
  it('reads twice with explicit target and never claims local acceptance', async () => {
    let calls = 0
    const input = await observePrReadiness(
      request,
      async (received) => {
        assert.deepEqual(received, request)
        calls++
        return fixture()
      },
      () => now,
    )
    assert.equal(calls, 2)
    assert.equal(input.complete, true)
    assert.equal(input.target.headSha, head)
    const decision = assessPrReadiness(input, now)
    assert.equal(decision.state, 'unknown')
    assert.deepEqual(
      decision.requirements.filter((item) => item.state !== 'ready').map((item) => item.key),
      ['acceptance'],
    )
    assert.equal(input.receipts.filter((item) => item.requirement.startsWith('check:')).length, 2)
  })
  for (const field of ['headRefOid', 'baseRefOid'] as const) {
    it(`refuses a changed ${field} between reads`, async () => {
      const second = fixture()
      prOf(second)[field] = 'd'.repeat(40)
      let calls = 0
      const input = await observePrReadiness(
        request,
        async () => (++calls === 1 ? fixture() : second),
        () => now,
      )
      assert.equal(input.complete, false)
      assert.ok(input.problems.some((problem) => problem.includes('changed')))
      assert.notEqual(assessPrReadiness(input, now).state, 'ready')
    })
  }
  it('detects a rerun starting on the same head during collection', async () => {
    const second = fixture()
    at(prOf(second).commits.nodes, 0).commit.statusCheckRollup.contexts.nodes = [check(11)]
    let calls = 0
    const input = await observePrReadiness(
      request,
      async () => (++calls === 1 ? fixture() : second),
      () => now,
    )
    assert.equal(input.complete, false)
  })
  for (const section of ['latestReviews', 'reviewThreads', 'checks'] as const) {
    it(`marks truncated ${section} incomplete`, async () => {
      const data = fixture()
      if (section === 'checks')
        at(prOf(data).commits.nodes, 0).commit.statusCheckRollup.contexts.pageInfo.hasNextPage =
          true
      else prOf(data)[section].pageInfo.hasNextPage = true
      const input = await observe(data)
      assert.equal(input.complete, false)
      assert.match(input.problems.join(' '), /page limit/)
    })
  }
  for (const state of [
    'FAILURE',
    'CANCELLED',
    'TIMED_OUT',
    'ACTION_REQUIRED',
    'STARTUP_FAILURE',
    'SKIPPED',
    'NEUTRAL',
    'NEW_STATE',
  ]) {
    it(`keeps ${state} distinguishable from a pass`, async () => {
      const data = fixture()
      at(prOf(data).commits.nodes, 0).commit.statusCheckRollup.contexts.nodes = [
        { ...check(), conclusion: state },
      ]
      const input = await observe(data)
      const checkDecision = assessPrReadiness(input, now).requirements.find((item) =>
        item.key.startsWith('check:'),
      )
      assert.notEqual(checkDecision?.state, 'ready')
      assert.equal(checkDecision?.evidence[0]?.detail, `COMPLETED/${state}`)
    })
  }
  it('does not borrow a check attached to another commit', async () => {
    const data = fixture()
    const wrong = check()
    wrong.checkSuite.commit.oid = 'd'.repeat(40)
    at(prOf(data).commits.nodes, 0).commit.statusCheckRollup.contexts.nodes = [wrong]
    const decision = assessPrReadiness(await observe(data), now)
    assert.equal(decision.historical.length, 1)
    assert.equal(
      decision.requirements.find((item) => item.key.startsWith('check:'))?.state,
      'unknown',
    )
  })
  it('refuses a head/rollup mismatch and unsupported test-merge checks', async () => {
    const data = fixture()
    at(prOf(data).commits.nodes, 0).commit.oid = 'd'.repeat(40)
    prOf(data).potentialMergeCommit.statusCheckRollup = { state: 'SUCCESS' }
    const input = await observe(data)
    assert.equal(input.complete, false)
    assert.equal(input.problems.length, 2)
  })
  it('keeps check runs and legacy statuses with the same name independent', async () => {
    const data = fixture()
    at(prOf(data).commits.nodes, 0).commit.statusCheckRollup.contexts.nodes = [
      check(999),
      { ...status(), state: 'FAILURE' },
    ]
    assert.equal(assessPrReadiness(await observe(data), now).state, 'blocked')
  })
  it('a newer run supersedes only its own source series', async () => {
    const data = fixture()
    at(prOf(data).commits.nodes, 0).commit.statusCheckRollup.contexts.nodes = [
      check(),
      { ...check(11), conclusion: 'FAILURE' },
    ]
    const result = assessPrReadiness(await observe(data), now)
    assert.equal(result.state, 'blocked')
    assert.equal(
      result.requirements.find((item) => item.key.startsWith('check:'))?.evidence[0]?.sequence,
      11,
    )
  })
  it('stale approvals, unresolved discussions and drafts are not ready', async () => {
    const data = fixture()
    at(prOf(data).latestReviews.nodes, 0).commit.oid = 'd'.repeat(40)
    at(prOf(data).reviewThreads.nodes, 0).isResolved = false
    prOf(data).isDraft = true
    const result = assessPrReadiness(await observe(data), now)
    assert.equal(result.requirements.find((item) => item.key === 'reviews')?.state, 'unknown')
    assert.equal(result.requirements.find((item) => item.key === 'threads')?.state, 'blocked')
    assert.equal(result.requirements.find((item) => item.key === 'draft')?.state, 'blocked')
  })
  it('missing required checks remain unknown via GitHub rule evaluation', async () => {
    const data = fixture()
    at(prOf(data).commits.nodes, 0).commit.statusCheckRollup.contexts.nodes = []
    prOf(data).mergeStateStatus = 'BLOCKED'
    const result = assessPrReadiness(await observe(data), now)
    assert.equal(result.requirements.find((item) => item.key === 'rules')?.state, 'unknown')
  })
  it('read failures never become empty green observations', async () => {
    await assert.rejects(
      observePrReadiness(request, async () => {
        throw new Error('403')
      }),
      /403/,
    )
    let calls = 0
    const input = await observePrReadiness(
      request,
      async () => {
        if (++calls === 2) throw new Error('rate limited')
        return fixture()
      },
      () => now,
    )
    assert.equal(input.confirmedTarget, null)
    assert.equal(input.complete, false)
  })
  it('refuses malformed, partial-error and cross-repository replies', async () => {
    await assert.rejects(observePrReadiness(request, async () => ({})))
    await assert.rejects(
      observePrReadiness(request, async () => ({ ...fixture(), errors: [{ message: 'partial' }] })),
      /partial/,
    )
    const wrong = fixture()
    wrong.data.repository.nameWithOwner = 'other/project'
    await assert.rejects(
      observePrReadiness(request, async () => wrong),
      /different/,
    )
  })
})
