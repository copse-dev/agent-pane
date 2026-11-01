import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideForwardEnvToken,
  formatGhPrFiles,
  formatGhPrList,
  formatGhPrView,
  ghEnv,
  collectRestPrList,
  type GhPrListEntry,
  isGhGraphQlRateLimited,
  REST_MERGED_MAX_PAGES,
  restPrMergeable,
  restPrState,
} from './gh-service.ts'

describe('formatGhPrList', () => {
  it('formats PR rows with branch and author', () => {
    const text = formatGhPrList([
      {
        number: 42,
        title: 'Add feature',
        url: 'https://github.com/org/repo/pull/42',
        state: 'OPEN',
        headRefName: 'feature',
        author: { login: 'alice' },
      },
    ])
    assert.match(text, /#42 Add feature — OPEN \(feature\) by alice/)
    assert.match(text, /https:\/\/github\.com\/org\/repo\/pull\/42/)
  })

  it('returns empty message for no PRs', () => {
    assert.equal(formatGhPrList([]), '(no pull requests)')
  })

  it('includes the fields needed for an open PR automation in detailed mode', () => {
    const text = formatGhPrList(
      [
        {
          number: 42,
          title: 'Add feature',
          url: 'https://github.com/org/repo/pull/42',
          state: 'OPEN',
          headRefName: 'feature',
          headRefOid: '123456789abcdef',
          baseRefName: 'main',
          isDraft: false,
          mergeStateStatus: 'CLEAN',
          mergeable: 'MERGEABLE',
          reviewDecision: 'APPROVED',
          labels: [{ name: 'ready' }],
          author: { login: 'alice' },
          updatedAt: '2026-10-10T12:34:00Z',
        },
      ],
      true,
    )
    assert.match(text, /Draft: no; Base: main; Head SHA: 123456789/)
    assert.match(text, /Merge state: CLEAN; Mergeable: MERGEABLE; Review: APPROVED/)
    assert.match(text, /Labels: ready; Updated: 2026-10-10T12:34:00Z/)
  })
})

describe('ghEnv', () => {
  it('always sets a PATH', () => {
    const env = ghEnv({ PATH: '/custom/bin' })
    assert.match(env['PATH'] ?? '', /\/custom\/bin/)
  })

  it('honours a launcher-controlled PATH', () => {
    const env = ghEnv({ PATH: '/fixture/bin', COPSE_PRESERVE_PATH: '1' })
    assert.equal(env['PATH'], '/fixture/bin')
  })

  it('always forwards non-token GitHub config vars (host/config dir)', () => {
    const env = ghEnv({
      PATH: '/bin',
      GH_HOST: 'github.example.com',
      GH_CONFIG_DIR: '/tmp/gh',
    })
    assert.equal(env['GH_HOST'], 'github.example.com')
    assert.equal(env['GH_CONFIG_DIR'], '/tmp/gh')
  })

  it('forwards GitHub bearer tokens only when includeTokens is set (#521 fallback)', () => {
    const env = ghEnv(
      { PATH: '/bin', GH_TOKEN: 'gh-tok', GITHUB_TOKEN: 'github-tok' },
      { includeTokens: true },
    )
    assert.equal(env['GH_TOKEN'], 'gh-tok')
    assert.equal(env['GITHUB_TOKEN'], 'github-tok')
  })

  it('blanks (not omits) bearer tokens by default so they cannot shadow gh auth login (#516)', () => {
    // Blanking matters because runGh spawns via runCommand, which merges this env
    // on top of process.env: an omitted key would leak the parent token through and
    // override gh's own config-dir credential. An empty value makes gh ignore it.
    const env = ghEnv({ PATH: '/bin', GH_TOKEN: 'gh-tok', GITHUB_TOKEN: 'github-tok' })
    assert.equal(env['GH_TOKEN'], '')
    assert.equal(env['GITHUB_TOKEN'], '')
  })

  it('leaves token keys absent when none are present and never forwards unrelated secrets', () => {
    const env = ghEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'secret' }, { includeTokens: true })
    assert.ok(!('GH_TOKEN' in env))
    assert.ok(!('GITHUB_TOKEN' in env))
    assert.ok(!('ANTHROPIC_API_KEY' in env))
  })
})

describe('decideForwardEnvToken', () => {
  it('never forwards when no token is present', () => {
    assert.equal(decideForwardEnvToken({ hasToken: false, configAuthWorks: false }), false)
    assert.equal(decideForwardEnvToken({ hasToken: false, configAuthWorks: true }), false)
  })

  it('does NOT forward the env token when gh config-dir auth already works (#516)', () => {
    // A working `gh auth login` credential must win; forwarding a local token here
    // is exactly the regression — a stale/wrong-scope token would shadow it.
    assert.equal(decideForwardEnvToken({ hasToken: true, configAuthWorks: true }), false)
  })

  it('forwards the env token as a fallback when gh has no config-dir auth (#521)', () => {
    assert.equal(decideForwardEnvToken({ hasToken: true, configAuthWorks: false }), true)
  })
})

describe('formatGhPrView', () => {
  it('includes branch, diff stats, and checks', () => {
    const text = formatGhPrView({
      number: 7,
      title: 'Fix bug',
      url: 'https://github.com/org/repo/pull/7',
      state: 'OPEN',
      headRefName: 'fix',
      baseRefName: 'main',
      author: { login: 'bob' },
      mergeable: 'MERGEABLE',
      changedFiles: 3,
      additions: 10,
      deletions: 2,
      statusCheckRollup: [{ name: 'CI', conclusion: 'SUCCESS' }],
      body: 'Fixes the crash.',
    })
    assert.match(text, /#7 Fix bug/)
    assert.match(text, /Branch: fix → main/)
    assert.match(text, /Files changed: 3/)
    assert.match(text, /Diff: \+10 -2/)
    assert.match(text, /CI: SUCCESS/)
    assert.match(text, /Fixes the crash\./)
  })
})

describe('isGhGraphQlRateLimited', () => {
  it('matches the real gh error for an exhausted GraphQL quota', () => {
    assert.equal(
      isGhGraphQlRateLimited('GraphQL: API rate limit already exceeded for user ID 338988.'),
      true,
    )
  })

  it('does not match an unrelated gh failure', () => {
    assert.equal(isGhGraphQlRateLimited('could not resolve to a PullRequest'), false)
  })
})

describe('collectRestPrList', () => {
  const pr = (number: number, state: string): GhPrListEntry => ({
    number,
    title: `PR ${String(number)}`,
    url: `https://github.com/o/r/pull/${String(number)}`,
    state,
  })
  const closedPage = (
    from: number,
    count: number,
    mergedAt: readonly number[] = [],
  ): GhPrListEntry[] =>
    Array.from({ length: count }, (_, i) =>
      pr(from + i, mergedAt.includes(from + i) ? 'MERGED' : 'CLOSED'),
    )

  it('reads further closed pages until it has the merged PRs asked for', async () => {
    const pages = [
      closedPage(1, 100),
      closedPage(101, 100, [150, 160]),
      closedPage(201, 100, [205]),
    ]
    const read: number[] = []
    const list = await collectRestPrList(true, 3, async (page, perPage) => {
      read.push(page)
      assert.equal(perPage, 100)
      return pages[page - 1] ?? []
    })
    assert.deepEqual(
      list?.map((entry) => entry.number),
      [150, 160, 205],
    )
    assert.deepEqual(read, [1, 2, 3])
  })

  it('stops at a short page and at the page cap', async () => {
    let calls = 0
    const short = await collectRestPrList(true, 20, async () => {
      calls += 1
      return closedPage(1, 40, [7])
    })
    assert.deepEqual(
      short?.map((entry) => entry.number),
      [7],
    )
    assert.equal(calls, 1)
    calls = 0
    await collectRestPrList(true, 20, async (page) => {
      calls += 1
      return closedPage(page * 100, 100)
    })
    assert.equal(calls, REST_MERGED_MAX_PAGES)
  })

  it('reads one page of the requested size for other states', async () => {
    const list = await collectRestPrList(false, 2, async (page, perPage) => {
      assert.equal(page, 1)
      assert.equal(perPage, 2)
      return [pr(1, 'OPEN'), pr(2, 'OPEN')]
    })
    assert.equal(list?.length, 2)
  })

  it('fails the whole list when any page fails', async () => {
    const list = await collectRestPrList(true, 5, async (page) =>
      page === 1 ? closedPage(1, 100, [3]) : null,
    )
    assert.equal(list, null)
  })
})

describe('restPrState', () => {
  it('reports MERGED when merged_at is set, regardless of state', () => {
    assert.equal(restPrState('closed', '2026-01-01T00:00:00Z'), 'MERGED')
  })

  it('uppercases a plain REST state', () => {
    assert.equal(restPrState('open', undefined), 'OPEN')
    assert.equal(restPrState('closed', undefined), 'CLOSED')
  })

  it('falls back to UNKNOWN when state is missing', () => {
    assert.equal(restPrState(undefined, undefined), 'UNKNOWN')
  })
})

describe('restPrMergeable', () => {
  it('maps the REST tri-state boolean to the GraphQL-shaped enum text', () => {
    assert.equal(restPrMergeable(true), 'MERGEABLE')
    assert.equal(restPrMergeable(false), 'CONFLICTING')
    assert.equal(restPrMergeable(null), 'UNKNOWN')
    assert.equal(restPrMergeable(undefined), 'UNKNOWN')
  })
})

describe('formatGhPrFiles', () => {
  it('lists each changed file with change type and line counts', () => {
    const text = formatGhPrFiles({
      number: 9,
      title: 'Add memories',
      url: 'https://github.com/org/repo/pull/9',
      changedFiles: 2,
      additions: 120,
      deletions: 4,
      files: [
        {
          path: 'src/main/services/okf-memory-store.ts',
          additions: 100,
          deletions: 0,
          changeType: 'ADDED',
        },
        {
          path: 'src/shared/tools/readonly-tools.ts',
          additions: 20,
          deletions: 4,
          changeType: 'MODIFIED',
        },
      ],
    })
    assert.match(text, /#9 Add memories — 2 files changed/)
    assert.match(text, /added\s+src\/main\/services\/okf-memory-store\.ts \(\+100 -0\)/)
    assert.match(text, /modified\s+src\/shared\/tools\/readonly-tools\.ts \(\+20 -4\)/)
    assert.match(text, /Total: \+120 -4/)
  })

  it('handles a PR with no per-file list', () => {
    const text = formatGhPrFiles({ number: 1, title: 'Empty', changedFiles: 0, files: [] })
    assert.match(text, /#1 Empty — 0 files changed/)
    assert.match(text, /no per-file list/)
  })

  it('singularizes a one-file change', () => {
    const text = formatGhPrFiles({
      number: 2,
      title: 'One',
      changedFiles: 1,
      files: [{ path: 'a.ts', additions: 1, deletions: 1, changeType: 'MODIFIED' }],
    })
    assert.match(text, /— 1 file changed/)
  })
})
