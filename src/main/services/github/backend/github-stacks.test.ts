import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  STACKS_MAX_PAGES,
  STACKS_PAGE_SIZE,
  loadRepoStacks,
  loadStackForPr,
  parseStack,
  parseStackList,
  stackContaining,
  stacksResponseFromGh,
  type StacksResponse,
} from './github-stacks.ts'

function restPull(number: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number,
    state: 'open',
    draft: false,
    merged_at: null,
    head: { ref: `branch-${String(number)}`, sha: 'abc' },
    ...extra,
  }
}

function restStack(number: number, pulls: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: 9_000 + number,
    number,
    node_id: 'S_kw',
    url: `https://api.github.com/repos/octo/demo/stacks/${String(number)}`,
    base: { ref: 'main' },
    open: true,
    created_at: '2026-10-01T00:00:00Z',
    pull_requests: pulls,
  }
}

describe('parseStack', () => {
  it('numbers entries from the bottom and keeps branch names', () => {
    const stack = parseStack(restStack(42, [restPull(101), restPull(102)]))
    assert.deepEqual(stack, {
      number: 42,
      baseRefName: 'main',
      open: true,
      entries: [
        {
          number: 101,
          position: 1,
          state: 'open',
          draft: false,
          merged: false,
          headRefName: 'branch-101',
        },
        {
          number: 102,
          position: 2,
          state: 'open',
          draft: false,
          merged: false,
          headRefName: 'branch-102',
        },
      ],
    })
  })

  it('treats merged and unknown states as closed so nothing looks mergeable by mistake', () => {
    const stack = parseStack(
      restStack(1, [
        restPull(1, { state: 'closed', merged_at: '2026-10-02T00:00:00Z' }),
        restPull(2, { state: 'merging' }),
        restPull(3, { draft: true }),
      ]),
    )
    assert.ok(stack)
    assert.deepEqual(
      stack.entries.map((entry) => [entry.state, entry.merged, entry.draft]),
      [
        ['closed', true, false],
        ['closed', false, false],
        ['open', false, true],
      ],
    )
  })

  it('derives open from the entries when GitHub omits it', () => {
    const raw = restStack(1, [restPull(1, { state: 'closed', merged_at: '2026-10-02T00:00:00Z' })])
    delete raw['open']
    assert.equal(parseStack(raw)?.open, false)
  })

  it('decodes the gh --jq projection, which writes omitted keys as null', () => {
    // STACKS_JQ builds objects with `{open, draft}` shorthand; jq emits `null`
    // for a key GitHub left out rather than dropping it.
    const response = stacksResponseFromGh({
      stdout: JSON.stringify([
        {
          number: 7,
          open: null,
          base: { ref: 'main' },
          pull_requests: [
            { number: 1, state: 'open', draft: null, merged_at: null, head: { ref: 'b1' } },
          ],
        },
      ]),
      stderr: '',
      code: 0,
      errorMessage: '',
    })
    assert.equal(response.kind, 'ok')
    const stacks = parseStackList(response.json)
    assert.ok(stacks)
    assert.deepEqual(
      stacks.map((stack) => [stack.open, stack.entries.map((entry) => entry.draft)]),
      [[true, [false]]],
    )
  })

  it('rejects payloads that are not a stack', () => {
    assert.equal(parseStack({ number: 'x' }), null)
    assert.equal(parseStack(restStack(1, [{ number: 1 }])), null)
    assert.equal(parseStackList({ message: 'Not Found' }), null)
  })
})

describe('stackContaining', () => {
  it('finds the stack holding a PR', () => {
    const stacks = parseStackList([
      restStack(1, [restPull(10), restPull(11)]),
      restStack(2, [restPull(20), restPull(21)]),
    ])
    assert.ok(stacks)
    assert.equal(stackContaining(stacks, 21)?.number, 2)
    assert.equal(stackContaining(stacks, 99), undefined)
  })
})

function fetcherFrom(
  responses: Record<string, StacksResponse>,
  seen: string[],
): (path: string) => Promise<StacksResponse> {
  return (path) => {
    seen.push(path)
    return Promise.resolve(responses[path] ?? { kind: 'ok', json: [] })
  }
}

describe('loadRepoStacks', () => {
  it('pages until a short page', async () => {
    const full = Array.from({ length: STACKS_PAGE_SIZE }, (_, i) =>
      restStack(i + 1, [restPull(1000 + 2 * i), restPull(1001 + 2 * i)]),
    )
    const seen: string[] = []
    const result = await loadRepoStacks(
      fetcherFrom(
        {
          'repos/octo/demo/stacks?per_page=100&page=1': { kind: 'ok', json: full },
          'repos/octo/demo/stacks?per_page=100&page=2': {
            kind: 'ok',
            json: [restStack(500, [restPull(1), restPull(2)])],
          },
        },
        seen,
      ),
      'octo',
      'demo',
    )
    assert.equal(result.status, 'enabled')
    assert.equal(result.stacks.length, STACKS_PAGE_SIZE + 1)
    assert.equal(seen.length, 2)
  })

  it('stops at the page bound', async () => {
    const full = Array.from({ length: STACKS_PAGE_SIZE }, (_, i) =>
      restStack(i + 1, [restPull(1), restPull(2)]),
    )
    const seen: string[] = []
    await loadRepoStacks(
      (path) => {
        seen.push(path)
        return Promise.resolve({ kind: 'ok', json: full })
      },
      'octo',
      'demo',
    )
    assert.equal(seen.length, STACKS_MAX_PAGES)
  })

  it('reports a 404 as stacks unavailable', async () => {
    const result = await loadRepoStacks(
      () => Promise.resolve({ kind: 'not-found' }),
      'octo',
      'demo',
    )
    assert.deepEqual(result, { status: 'unavailable' })
  })

  it('throws on errors and unexpected payloads instead of reporting no stacks', async () => {
    await assert.rejects(
      loadRepoStacks(
        () => Promise.resolve({ kind: 'error', message: 'Bad credentials' }),
        'octo',
        'demo',
      ),
      /Bad credentials/,
    )
    await assert.rejects(
      loadRepoStacks(() => Promise.resolve({ kind: 'ok', json: { stacks: [] } }), 'octo', 'demo'),
      /Unexpected response listing stacks for octo\/demo/,
    )
  })
})

describe('loadStackForPr', () => {
  const ref = { owner: 'octo', repo: 'demo', number: 102 }

  it('asks for the stack containing the PR', async () => {
    const seen: string[] = []
    const stack = await loadStackForPr(
      fetcherFrom(
        {
          'repos/octo/demo/stacks?pull_request=102': {
            kind: 'ok',
            json: [restStack(42, [restPull(101), restPull(102)])],
          },
        },
        seen,
      ),
      ref,
    )
    assert.equal(stack?.number, 42)
    assert.deepEqual(seen, ['repos/octo/demo/stacks?pull_request=102'])
  })

  it('is best-effort: 404s, errors, throws and mismatched stacks give no stack', async () => {
    const responses: Array<StacksResponse | Error> = [
      { kind: 'not-found' },
      { kind: 'error', message: 'boom' },
      new Error('network'),
      { kind: 'ok', json: { message: 'odd' } },
      { kind: 'ok', json: [restStack(1, [restPull(1), restPull(2)])] },
    ]
    for (const response of responses) {
      const fetchPath = (): Promise<StacksResponse> =>
        response instanceof Error ? Promise.reject(response) : Promise.resolve(response)
      assert.equal(await loadStackForPr(fetchPath, ref), undefined)
    }
  })
})

describe('stacksResponseFromGh', () => {
  it('reads a 404 from gh stderr as stacks unavailable', () => {
    assert.deepEqual(
      stacksResponseFromGh({
        stdout: '',
        stderr: 'gh: Not Found (HTTP 404)',
        code: 1,
        errorMessage: 'gh: Not Found (HTTP 404)',
      }),
      { kind: 'not-found' },
    )
  })

  it('keeps other failures as errors with the formatted message', () => {
    assert.deepEqual(
      stacksResponseFromGh({
        stdout: '',
        stderr: 'gh: Bad credentials (HTTP 401)',
        code: 1,
        errorMessage: 'gh: Bad credentials (HTTP 401)',
      }),
      { kind: 'error', message: 'gh: Bad credentials (HTTP 401)' },
    )
  })

  it('parses stdout on success', () => {
    assert.deepEqual(
      stacksResponseFromGh({ stdout: ' [] \n', stderr: '', code: 0, errorMessage: '' }),
      { kind: 'ok', json: [] },
    )
  })
})
