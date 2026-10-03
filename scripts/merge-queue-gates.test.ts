import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { evaluateMergeQueueGates, type QueueGateGitHub } from './merge-queue-gates.mts'

const input = {
  owner: 'copse-dev',
  repo: 'agent-pane',
  baseRef: 'refs/heads/main',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
}
const prHead = 'c'.repeat(40)
function queue(pr = 1, head = prHead): unknown {
  return {
    repository: {
      mergeQueue: {
        entries: {
          nodes: [
            {
              id: 'entry-1',
              position: 1,
              baseCommit: { oid: input.baseSha },
              headCommit: { oid: input.headSha },
              pullRequest: { number: pr, headRefOid: head },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  }
}
function pull(head = prHead): unknown {
  return {
    state: 'open',
    draft: false,
    head: { sha: head },
    base: { ref: 'main', repo: { full_name: 'copse-dev/agent-pane' } },
  }
}
function status(context: string, id: number, state = 'success', author = 41898282): unknown {
  return { context, id, state, creator: { id: author } }
}
function fixture(
  options: {
    queues?: unknown[]
    pulls?: unknown[]
    statuses?: unknown[][]
    comparison?: unknown
    apiError?: boolean
  } = {},
): { github: QueueGateGitHub; writes: { context: string; state: string; sha: string }[] } {
  let queueRead = 0
  let pullRead = 0
  let statusRead = 0
  const queues = options.queues ?? [queue()]
  const pulls = options.pulls ?? [pull()]
  const statuses = options.statuses ?? [[status('CLA', 1), status('Screenshot review', 2)]]
  const writes: { context: string; state: string; sha: string }[] = []
  const github: QueueGateGitHub = {
    graphql: async () => {
      if (options.apiError) throw new Error('GitHub unavailable')
      return queues[Math.min(queueRead++, queues.length - 1)]
    },
    rest: {
      pulls: { get: async () => ({ data: pulls[Math.min(pullRead++, pulls.length - 1)] }) },
      repos: {
        compareCommits: async ({ base, head }) => {
          assert.equal(base, prHead)
          assert.equal(head, input.headSha)
          return {
            data: options.comparison ?? {
              status: 'ahead',
              behind_by: 0,
              merge_base_commit: { sha: prHead },
            },
          }
        },
        listCommitStatuses: async ({ ref }) => {
          assert.equal(ref, prHead)
          return { data: statuses[Math.min(statusRead++, statuses.length - 1)] }
        },
        createCommitStatus: async (write) => {
          writes.push(write)
        },
      },
    },
  }
  return { github, writes }
}

async function refuses(options: Parameters<typeof fixture>[0], message: RegExp): Promise<void> {
  const f = fixture(options)
  await assert.rejects(evaluateMergeQueueGates(f.github, input), message)
  assert.equal(
    f.writes.some((write) => write.state === 'success'),
    false,
  )
  assert.deepEqual(
    f.writes.slice(-2).map((write) => write.state),
    ['error', 'error'],
  )
}

describe('merge queue decision bridge', () => {
  it('copies only verified current-head decisions onto the exact synthetic SHA', async () => {
    const f = fixture()
    await evaluateMergeQueueGates(f.github, input)
    assert.deepEqual(
      f.writes.map((write) => [write.context, write.state, write.sha]),
      [
        ['CLA', 'pending', input.headSha],
        ['Screenshot review', 'pending', input.headSha],
        ['CLA', 'success', input.headSha],
        ['Screenshot review', 'success', input.headSha],
      ],
    )
  })
  it('refuses unavailable or malformed queue membership', async () => {
    await refuses({ queues: [{ repository: { mergeQueue: null } }] }, /membership unavailable/)
    await refuses({ apiError: true }, /GitHub unavailable/)
  })
  it('refuses ambiguous matching entries and entries behind the first queue position', async () => {
    const node = {
      id: 'entry-1',
      position: 1,
      baseCommit: { oid: input.baseSha },
      headCommit: { oid: input.headSha },
      pullRequest: { number: 1, headRefOid: prHead },
    }
    const result = (nodes: unknown[]): unknown => ({
      repository: {
        mergeQueue: { entries: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } },
      },
    })
    await refuses({ queues: [result([node, { ...node, id: 'entry-2' }])] }, /exactly one/)
    await refuses({ queues: [result([{ ...node, position: 2 }])] }, /exactly one/)
    await refuses(
      { queues: [result([{ ...node, baseCommit: { oid: 'd'.repeat(40) } }])] },
      /exactly one/,
    )
  })
  it('refuses a queued PR that closes, becomes draft or changes its base', async () => {
    const current = {
      state: 'open',
      draft: false,
      head: { sha: prHead },
      base: { ref: 'main', repo: { full_name: 'copse-dev/agent-pane' } },
    }
    await refuses({ pulls: [{ ...current, state: 'closed' }] }, /admitted head/)
    await refuses({ pulls: [{ ...current, draft: true }] }, /admitted head/)
    await refuses(
      { pulls: [{ ...current, base: { ...current.base, ref: 'release' } }] },
      /admitted head/,
    )
  })
  it('refuses a PR head changed immediately before publishing', async () => {
    await refuses({ pulls: [pull(), pull('d'.repeat(40))] }, /admitted head/)
  })
  it('refuses a PR head changed after the first queue snapshot', async () => {
    await refuses({ pulls: [pull('d'.repeat(40))] }, /admitted head/)
  })
  it('refuses group members changed during validation', async () => {
    await refuses({ queues: [queue(), queue(2)] }, /membership changed/)
  })
  it('refuses a current head changed before the first snapshot but absent from the synthetic commit', async () => {
    await refuses(
      {
        comparison: { status: 'diverged', behind_by: 1, merge_base_commit: { sha: input.baseSha } },
      },
      /Synthetic commit/,
    )
  })
  it('refuses missing or divergent ancestry proof', async () => {
    await refuses({ comparison: {} }, /Synthetic commit/)
    await refuses(
      {
        comparison: { status: 'diverged', behind_by: 1, merge_base_commit: { sha: input.baseSha } },
      },
      /Synthetic commit/,
    )
  })
  for (const state of ['pending', 'error', 'failure']) {
    it(`refuses a ${state} source gate rather than an older successful decision`, async () => {
      await refuses(
        {
          statuses: [
            [
              status('CLA', 1),
              status('Screenshot review', 2),
              status('Screenshot review', 3, state),
            ],
          ],
        },
        /Screenshot review/,
      )
    })
  }
  it('refuses an untrusted latest writer even if an older trusted decision passed', async () => {
    await refuses(
      {
        statuses: [
          [status('CLA', 1), status('Screenshot review', 2), status('CLA', 3, 'success', 123)],
        ],
      },
      /CLA/,
    )
  })
  it('refuses missing source gates', async () => {
    await refuses({ statuses: [[status('CLA', 1)]] }, /Screenshot review/)
  })
  it('refuses a revoked decision between validation and publication', async () => {
    await refuses(
      {
        statuses: [
          [status('CLA', 1), status('Screenshot review', 2)],
          [status('CLA', 1), status('Screenshot review', 3, 'error')],
        ],
      },
      /Screenshot review/,
    )
  })
  it('never executes the candidate checkout or installs its dependencies', () => {
    const workflow = readFileSync('.github/workflows/merge-queue-gates.yml', 'utf8')
    assert.match(workflow, /merge_group:\s+types: \[checks_requested\]/)
    assert.match(workflow, /ref: \$\{\{ github.event.merge_group.base_sha \}\}/)
    assert.match(workflow, /persist-credentials: false/)
    assert.match(workflow, /sparse-checkout: scripts\/merge-queue-gates.mts/)
    assert.doesNotMatch(workflow, /(?:pnpm|npm) (?:install|run)/)
    assert.match(workflow, /GROUP_HEAD_SHA: \$\{\{ github.event.merge_group.head_sha \}\}/)
  })
})
