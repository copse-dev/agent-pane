import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { replyToReviewThread, setReviewThreadResolved } from './pr-review-thread-actions.ts'

const REF = { owner: 'Octo', repo: 'Demo', number: 7 }

type Call = { query: string; variables: Record<string, string> }

function ownerReply(nameWithOwner = 'octo/demo', number = 7, isResolved = false): unknown {
  return {
    node: {
      __typename: 'PullRequestReviewThread',
      isResolved,
      pullRequest: { number, repository: { nameWithOwner } },
    },
  }
}

function graphql(replies: Array<{ data: unknown; errorMessage?: string }>): {
  run: (
    query: string,
    variables: Record<string, string>,
  ) => Promise<{ data: unknown; errorMessage?: string }>
  calls: Call[]
} {
  const calls: Call[] = []
  return {
    calls,
    run: (query, variables): Promise<{ data: unknown; errorMessage?: string }> => {
      calls.push({ query, variables })
      return Promise.resolve(replies.shift() ?? { data: null, errorMessage: 'unexpected call' })
    },
  }
}

describe('review thread replies', () => {
  it('checks the thread is on the PR, then posts the reply once', async () => {
    const api = graphql([
      { data: ownerReply() },
      { data: { addPullRequestReviewThreadReply: { comment: { id: 'c9' } } } },
    ])
    const result = await replyToReviewThread(api.run, 'api', REF, 'PRRT_1', 'Fixed')
    assert.deepEqual(result, { ok: true, backend: 'api', message: 'Reply posted.' })
    assert.equal(api.calls.length, 2)
    const [check, write] = api.calls
    assert.ok(check && write)
    assert.match(check.query, /node\(id: \$id\)/)
    assert.deepEqual(write.variables, { id: 'PRRT_1', body: 'Fixed' })
    assert.match(write.query, /addPullRequestReviewThreadReply/)
  })

  it('refuses a thread from another repository or PR without writing', async () => {
    for (const owner of [ownerReply('octo/other'), ownerReply('octo/demo', 8), { node: null }]) {
      const api = graphql([{ data: owner }])
      const result = await replyToReviewThread(api.run, 'cli', REF, 'PRRT_x', 'Hi')
      assert.equal(result.ok, false)
      assert.match(result.message, /not on PR #7/)
      assert.equal(api.calls.length, 1)
    }
  })

  it('rejects an empty reply and reports failures without retrying', async () => {
    const empty = graphql([])
    assert.equal((await replyToReviewThread(empty.run, 'cli', REF, 'PRRT_1', '  ')).ok, false)
    assert.equal(empty.calls.length, 0)

    const denied = graphql([{ data: ownerReply() }, { data: null, errorMessage: 'Forbidden' }])
    const result = await replyToReviewThread(denied.run, 'cli', REF, 'PRRT_1', 'Hi')
    assert.deepEqual(result, { ok: false, backend: 'cli', message: 'Forbidden' })
    assert.equal(denied.calls.length, 2)

    const unconfirmed = graphql([{ data: ownerReply() }, { data: {} }])
    const uncertain = await replyToReviewThread(unconfirmed.run, 'cli', REF, 'PRRT_1', 'Hi')
    assert.equal(uncertain.ok, false)
    assert.match(uncertain.message, /Refresh to check before posting again/)
    assert.equal(unconfirmed.calls.length, 2)
  })
})

describe('review thread resolution', () => {
  it('resolves and reopens with the matching mutation', async () => {
    const resolve = graphql([
      { data: ownerReply() },
      { data: { resolveReviewThread: { thread: { isResolved: true } } } },
    ])
    assert.deepEqual(await setReviewThreadResolved(resolve.run, 'api', REF, 'PRRT_1', true), {
      ok: true,
      backend: 'api',
      message: 'Thread resolved.',
    })
    assert.match(resolve.calls[1]?.query ?? '', /resolveReviewThread\(/)
    assert.doesNotMatch(resolve.calls[1]?.query ?? '', /unresolveReviewThread/)

    const reopen = graphql([
      { data: ownerReply('octo/demo', 7, true) },
      { data: { unresolveReviewThread: { thread: { isResolved: false } } } },
    ])
    const result = await setReviewThreadResolved(reopen.run, 'api', REF, 'PRRT_1', false)
    assert.equal(result.message, 'Thread reopened.')
    assert.match(reopen.calls[1]?.query ?? '', /unresolveReviewThread/)
  })

  it('treats an already-matching state as a no-op and an unconfirmed change as a failure', async () => {
    const already = graphql([{ data: ownerReply('octo/demo', 7, true) }])
    const noop = await setReviewThreadResolved(already.run, 'cli', REF, 'PRRT_1', true)
    assert.equal(noop.ok, true)
    assert.equal(noop.noop, true)
    assert.equal(already.calls.length, 1)

    const unconfirmed = graphql([
      { data: ownerReply() },
      { data: { resolveReviewThread: { thread: { isResolved: false } } } },
    ])
    const result = await setReviewThreadResolved(unconfirmed.run, 'cli', REF, 'PRRT_1', true)
    assert.equal(result.ok, false)
  })
})
