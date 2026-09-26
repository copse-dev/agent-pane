import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Finding } from './finding.ts'
import {
  buildForgeReview,
  ForgeReviewError,
  postForgeReview,
  renderFindingComment,
  type FetchLike,
  type ForgeTarget,
} from './forge-review.ts'
import type { Stage0Report } from './stage0.ts'
import type { ReviewReport } from './stage5.ts'

const anchored: Finding = {
  id: '0123456789abcdef',
  anchor: { path: 'src/math.ts', startLine: 3, endLine: 4 },
  claim: 'add subtracts its second argument instead of adding it.',
  class: 'contract',
  severity: 'high',
  confidence: 'high',
  provenance: {
    raisedBy: [{ kind: 'model', id: 'gpt-5', lens: 'correctness' }],
    corroboratedBy: [{ kind: 'model', id: 'claude-opus-4-8', lens: 'contracts' }],
    challengedBy: [],
  },
  evidence: [
    {
      kind: 'reproducer',
      testPath: '.copse-review/add.test.cjs',
      failsOnHead: true,
      passesOnBase: true,
    },
    {
      kind: 'command',
      command: 'node .copse-review/add.test.cjs',
      target: 'head',
      exitCode: 1,
      excerpt: 'AssertionError',
    },
  ],
  verdict: { status: 'confirmed', reason: 'The reproducer fails on head and passes on base.' },
}

const unanchored: Finding = {
  id: 'fedcba9876543210',
  anchor: { path: 'package.json' },
  claim: '`pnpm run test` fails on head and passes on base',
  class: 'test',
  severity: 'high',
  confidence: 'high',
  provenance: {
    raisedBy: [{ kind: 'stage0', id: 'stage0' }],
    corroboratedBy: [],
    challengedBy: [],
  },
  evidence: [],
  verdict: { status: 'confirmed', reason: 'exit 1 on head, exit 0 on base' },
}

const stage0: Stage0Report = {
  version: 1,
  repositoryRoot: '/repo',
  baseRef: 'origin/main',
  mergeBase: 'a'.repeat(40),
  headCommit: 'b'.repeat(40),
  dirtyWorkingTree: false,
  execution: {
    backend: 'ephemeral-runner',
    strength: 'container',
    decision: { execute: true, reason: 'foreign diff inside an ephemeral container' },
  },
  project: { head: null, base: null },
  preparation: { head: null, base: null },
  checks: [
    { kind: 'typecheck', verdict: 'clean', head: null, base: null },
    { kind: 'test', verdict: 'regressed', head: null, base: null },
  ],
  findings: [unanchored],
  coverage: { checked: ['typecheck', 'test'], notChecked: [{ kind: 'lint', reason: 'timed out' }] },
  durationMs: 10,
}

function report(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    version: 2,
    stage0,
    context: null,
    reviews: [
      {
        model: 'gpt-5',
        lens: 'correctness',
        turnId: 't1',
        outcome: 'completed',
        stopReason: 'end_turn',
        candidates: 1,
        toolCalls: 2,
        usage: { inputTokens: 1, outputTokens: 1, estimated: false },
        summary: '',
        completion: {
          checked: 'The changed implementation and its direct callers.',
          couldNotVerify: 'Nothing',
        },
      },
    ],
    verification: null,
    findings: [anchored, unanchored],
    appendix: [],
    refuted: [],
    durationMs: 100,
    ...overrides,
  }
}

const target: ForgeTarget = {
  forge: 'github',
  apiBase: 'https://api.github.com',
  owner: 'copse-dev',
  repo: 'agent-pane',
  number: 42,
  token: 'ghs_token',
  headCommit: 'b'.repeat(40),
}

const mathDiff = `diff --git a/src/math.ts b/src/math.ts
--- a/src/math.ts
+++ b/src/math.ts
@@ -2,2 +2,3 @@
 context
-old
+new
+new
@@ -20 +21 @@
-old
+new
\\ No newline at end of file
`

interface Call {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

function fakeFetch(statuses: number[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const queue = [...statuses]
  const fetch: FetchLike = (url, init) => {
    const body: unknown = JSON.parse(init.body ?? '{}')
    assert.ok(typeof body === 'object' && body !== null)
    calls.push({ url, headers: init.headers, body: { ...body } })
    const status = queue.shift() ?? 200
    return Promise.resolve({
      status,
      text: () => Promise.resolve(status === 422 ? '{"message":"Unprocessable"}' : ''),
    })
  }
  return { fetch, calls }
}

describe('forge review', () => {
  it('renders a finding with its verdict, evidence and provenance', () => {
    const text = renderFindingComment(anchored)
    assert.match(text, /^\*\*add subtracts/)
    assert.match(text, /Confirmed by an automated check\./)
    assert.match(text, /reproducer `\.copse-review\/add\.test\.cjs`: fails on head, passes on base/)
    assert.match(text, /`node \.copse-review\/add\.test\.cjs` on head: exit 1/)
    assert.match(
      text,
      /raised by gpt-5 \(correctness\); corroborated by claude-opus-4-8 · id `0123456789abcdef`/,
    )
  })

  it('keeps the actionable claim and uncertainty visible while folding technical evidence', () => {
    const text = renderFindingComment({
      ...anchored,
      verdict: {
        status: 'unverified',
        reason: 'A caller can trigger this. </details> quoted markup.',
      },
    })
    const visible = text.split('<details>')[0] ?? ''
    assert.match(visible, /add subtracts/)
    assert.match(visible, /Possible issue — not confirmed by a test/)
    assert.doesNotMatch(visible, /contract|gpt-5|0123456789abcdef|node \.copse-review/)
    assert.match(text, /<summary>Why this was flagged<\/summary>/)
    assert.match(text, /&lt;\/details&gt; quoted markup/)
    assert.equal(text.match(/<\/details>/g)?.length, 1)
  })

  it('posts model text as inert markdown: no mentions, no raw HTML, intact code spans', () => {
    const text = renderFindingComment({
      ...anchored,
      claim: 'Ping @copse-dev/maintainers: `Array<string>` breaks <!-- the rest',
      verdict: { status: 'unverified', reason: 'See ``<!--` and @octocat.' },
      evidence: [
        {
          kind: 'command',
          command: 'node -e "console.log(`x`)"\nrm -rf x',
          target: 'head',
          exitCode: 1,
          excerpt: '',
        },
      ],
    })
    assert.doesNotMatch(text, /@copse-dev|@octocat/, 'no live mentions')
    assert.match(text, /@\u200bcopse-dev\/maintainers/)
    assert.doesNotMatch(text, /<!--/, 'an unterminated comment cannot hide the rest')
    assert.match(text, /&lt;!-- the rest/)
    assert.match(text, /`Array<string>`/, 'code spans stay as written')
    assert.ok(text.includes('\\`\\`&lt;!--\\` and'), 'unclosed backticks are inert')
    assert.match(text, /- ``node -e "console\.log\(`x`\)" rm -rf x`` on head: exit 1/)
  })

  it('escapes paragraph-crossing and unmatched code delimiters before posting', () => {
    for (const claim of [
      'A `fragment\n\n<!-- harmless rendering probe\n\n` ends',
      'A `fragment\r\n \r\n<!-- comment\r\n` ends',
      'A \\`fragment <!-- comment ` ends',
      '```\n<!-- comment\n```',
      '```unclosed fence',
    ]) {
      const text = renderFindingComment({
        ...anchored,
        claim,
        verdict: { status: 'unverified', reason: claim },
      })
      assert.doesNotMatch(text, /<!--/)
      assert.doesNotMatch(text, /^`/m, 'no model-created fence can consume following details')
      assert.match(text, /priority\./)
      assert.match(text, /<summary>Why this was flagged<\/summary>/)
      assert.equal(text.match(/<\/details>/g)?.length, 1)
    }
  })

  it('keeps incomplete status outside the collapsed details', () => {
    const source = report()
    const review = buildForgeReview(
      { ...source, reviews: source.reviews.map((r) => ({ ...r, outcome: 'failed' })) },
      { headCommit: target.headCommit, toolVersion: 'test' },
    )
    assert.match(review.body.split('<details>')[0] ?? '', /Review stopped early/)
  })

  it('puts task timings inside review details and keeps material gaps visible', () => {
    const source = report({ findings: [] })
    const review = buildForgeReview(
      {
        ...source,
        reviews: source.reviews.map((entry) => ({
          ...entry,
          timing: { durationMs: 3_000, toolMs: 1_000, modelAndOverheadMs: 2_000 },
          completion: {
            checked: 'The changed implementation.',
            couldNotVerify: 'The resize path.',
          },
        })),
      },
      { headCommit: target.headCommit, toolVersion: 'test' },
    )
    const visible = review.body.split('<details>')[0] ?? ''
    assert.match(visible, /Some checks remain unverified/)
    assert.doesNotMatch(visible, /gpt-5|ephemeral-runner|3\.0s/)
    assert.match(review.body, /<summary>Review details<\/summary>/)
    assert.match(review.body, /\| Find issues \| 3\.0s \| 1\.0s \| 2\.0s \|/)
    assert.match(review.body, /The resize path/)
  })

  it('anchors findings with a line inline and puts the rest in the body', () => {
    const review = buildForgeReview(report(), {
      headCommit: target.headCommit,
      toolVersion: '0.1.0',
    })
    assert.deepEqual(
      review.comments.map((comment) => [comment.path, comment.line]),
      [['src/math.ts', 4]],
    )
    assert.match(review.body, /### Copse Reviewer/)
    assert.match(review.body, /Executed in the `ephemeral-runner` backend \(container\)/)
    assert.match(review.body, /Checks: typecheck ✓, test ✗ regressed\./)
    assert.match(review.body, /Not checked: lint — timed out\./)
    assert.match(review.body, /2 issues to review\. See the inline comment\./)
    assert.match(review.body, /---\n\n#### Issue 2\n\n`package\.json`\n\n\*\*`pnpm run test`/)
    assert.doesNotMatch(
      review.body,
      /add subtracts/,
      'the inline finding is not repeated in the body',
    )
    assert.match(review.body, /this review does not block merging/)
    assert.match(review.body, /<!-- copse-review:b{40} -->/)
  })

  it('only anchors to head-side hunk lines within the finding range', () => {
    const options = {
      headCommit: target.headCommit,
      toolVersion: 'test',
      fileDiffs: new Map([['src/math.ts', mathDiff]]),
    }
    for (const [startLine, endLine, expected] of [
      [3, 4, 4],
      [2, 2, 2],
      [3, 10, 4],
      [5, 20, undefined],
      [21, 21, 21],
      [22, 30, undefined],
    ]) {
      const finding = { ...anchored, anchor: { path: 'src/math.ts', startLine, endLine } }
      const review = buildForgeReview(report({ findings: [finding] }), options)
      assert.equal(
        review.comments[0]?.line,
        expected,
        `range ${String(startLine)}–${String(endLine)}`,
      )
      assert.equal(review.body.includes(anchored.claim), expected === undefined)
    }
  })

  it('keeps missing files, deleted lines and binary files in the body', () => {
    for (const diff of [
      '',
      '@@ -3,2 +2,0 @@\n-old\n-old\n',
      'Binary files a/src/math.ts and b/src/math.ts differ\n',
    ]) {
      const review = buildForgeReview(report({ findings: [anchored] }), {
        headCommit: target.headCommit,
        toolVersion: 'test',
        fileDiffs: new Map([['src/math.ts', diff]]),
      })
      assert.deepEqual(review.comments, [])
      assert.match(review.body, /add subtracts/)
    }
  })

  it('numbers and separates body issues outside the collapsed evidence', () => {
    const review = buildForgeReview(report(), { headCommit: null, toolVersion: 'test' })
    assert.deepEqual(review.comments, [], 'a missing commit cannot anchor an inline comment')
    assert.match(review.body, /---\n\n#### Issue 1\n\n`src\/math\.ts:3`/)
    assert.match(review.body, /<\/details>\n\n---\n\n#### Issue 2\n\n`package\.json`/)
    assert.match(review.body, /<\/details>\n\n---\n\n<details>\n<summary>Review details/)
  })

  it('is one clean line when nothing was found', () => {
    const review = buildForgeReview(report({ findings: [], reviews: [] }), {
      headCommit: null,
      toolVersion: '0.1.0',
    })
    assert.equal(review.comments.length, 0)
    assert.match(review.body, /No issues found by the automated checks\./)
    assert.doesNotMatch(review.body, /Head:/)
  })

  it('never presents an incomplete reviewer run as a clean review', () => {
    const review = buildForgeReview(
      report({
        findings: [],
        reviews: [
          {
            model: 'qwen3.8-27b',
            lens: 'correctness',
            turnId: 't-incomplete',
            outcome: 'failed',
            stopReason: 'error',
            candidates: 0,
            toolCalls: 24,
            usage: { inputTokens: 479_515, outputTokens: 60_340, estimated: false },
            summary: 'The agent stopped before producing a final answer.',
            completion: null,
            error: 'reviewer stopped without calling the required finish_review tool',
          },
        ],
      }),
      { headCommit: target.headCommit, toolVersion: '0.1.0' },
    )
    assert.match(review.body, /Review incomplete: 1 of 1 reviewer run\(s\)/)
    assert.match(review.body, /without calling the required finish_review tool/)
    assert.match(review.body, /No issues were reported before the review stopped\./)
    assert.doesNotMatch(review.body, /\nNo issues found\.\n/)
  })

  it('surfaces material uncertainty instead of presenting a false-clean review', () => {
    const review = buildForgeReview(
      report({
        findings: [],
        reviews: [
          {
            model: 'qwen3.8-27b',
            lens: 'correctness',
            turnId: 't-limited',
            outcome: 'completed',
            stopReason: 'end_turn',
            candidates: 0,
            toolCalls: 19,
            usage: { inputTokens: 267_258, outputTokens: 35_960, estimated: false },
            summary:
              'Checked: the changed bundle configuration.\nCould not verify: jsdom source was absent from the review workspace.',
            completion: {
              checked: 'The changed bundle configuration and its consumers.',
              couldNotVerify: 'jsdom source was absent from the review workspace.',
            },
          },
        ],
      }),
      { headCommit: target.headCommit, toolVersion: '0.1.0' },
    )
    assert.match(review.body, /Review limits: 1 completed reviewer run\(s\)/)
    assert.match(
      review.body,
      /Could not verify \(qwen3\.8-27b, correctness\): jsdom source was absent/,
    )
    assert.match(review.body, /No issues were reported, but the review has gaps\./)
    assert.doesNotMatch(review.body, /\nNo issues found\.\n/)
  })

  it('posts a GitHub review with inline comments on the head commit', async () => {
    const { fetch, calls } = fakeFetch([200])
    const posted = await postForgeReview(target, report(), { toolVersion: '0.1.0', fetch })
    assert.deepEqual(posted, { inline: 1, folded: 0 })
    const [call] = calls
    assert.ok(call)
    assert.equal(call.url, 'https://api.github.com/repos/copse-dev/agent-pane/pulls/42/reviews')
    assert.equal(call.headers['Authorization'], 'Bearer ghs_token')
    assert.equal(call.body['event'], 'COMMENT')
    assert.equal(call.body['commit_id'], target.headCommit)
    assert.deepEqual(call.body['comments'], [
      { path: 'src/math.ts', line: 4, side: 'RIGHT', body: renderFindingComment(anchored) },
    ])
  })

  it("supersedes its own earlier reviews on a re-run and leaves everyone else's alone", async () => {
    const sha = 'c'.repeat(40)
    const reviews = [
      { id: 1, user: { login: 'copse-bot[bot]' }, body: `old <!-- copse-review:${sha} -->` },
      { id: 2, user: { login: 'someone' }, body: `quoted <!-- copse-review:${sha} -->` },
      { id: 3, user: { login: 'copse-bot[bot]' }, body: 'an unrelated review by the same app' },
      { id: 9, user: { login: 'copse-bot[bot]' }, body: `new <!-- copse-review:${sha} -->` },
    ]
    const calls: { method: string; url: string; body: unknown }[] = []
    const fetch: FetchLike = (url, init) => {
      calls.push({
        method: init.method,
        url,
        body: init.body === undefined ? undefined : JSON.parse(init.body),
      })
      const json = (value: unknown): ReturnType<FetchLike> =>
        Promise.resolve({ status: 200, text: () => Promise.resolve(JSON.stringify(value)) })
      if (init.method === 'POST' && url.endsWith('/reviews')) {
        return json({
          id: 9,
          html_url: 'https://github.com/o/r/pull/42#pullrequestreview-9',
          user: { login: 'copse-bot[bot]' },
        })
      }
      if (init.method === 'GET' && url.includes('/reviews?')) return json(reviews)
      if (init.method === 'GET' && url.endsWith('/reviews/1/comments?per_page=100')) {
        return json([{ node_id: 'PRRC_a' }, { node_id: 'PRRC_b' }])
      }
      return json({})
    }
    const posted = await postForgeReview(target, report(), { toolVersion: 'test', fetch })
    assert.equal(posted.superseded, 1)
    assert.equal(posted.supersedeError, undefined)
    const edits = calls.filter((call) => call.method === 'PUT')
    assert.deepEqual(
      edits.map((call) => call.url),
      ['https://api.github.com/repos/copse-dev/agent-pane/pulls/42/reviews/1'],
    )
    assert.match(
      JSON.stringify(edits[0]?.body),
      /Superseded by \[a newer review\]\(https:\/\/github\.com\/o\/r\/pull\/42#pullrequestreview-9\)/,
    )
    const hidden = calls.filter((call) => call.url === 'https://api.github.com/graphql')
    assert.deepEqual(
      hidden.map((call) => JSON.stringify(call.body)).map((body) => /PRRC_[ab]/.exec(body)?.[0]),
      ['PRRC_a', 'PRRC_b'],
    )
    assert.ok(hidden.every((call) => /classifier: OUTDATED/.test(JSON.stringify(call.body))))
    assert.ok(
      calls.filter((call) => call.method === 'GET').every((call) => call.body === undefined),
    )
  })

  it('still reports the posted review when superseding earlier ones fails', async () => {
    const fetch: FetchLike = (_url, init) => {
      if (init.method === 'POST') {
        return Promise.resolve({
          status: 200,
          text: () =>
            Promise.resolve(JSON.stringify({ id: 9, html_url: 'u', user: { login: 'bot' } })),
        })
      }
      return Promise.resolve({ status: 403, text: () => Promise.resolve('forbidden') })
    }
    const posted = await postForgeReview(target, report(), { toolVersion: 'test', fetch })
    assert.equal(posted.inline, 1)
    assert.match(posted.supersedeError ?? '', /403/)
  })

  it('speaks Forgejo: /api/v1, token auth, new_position', async () => {
    const { fetch, calls } = fakeFetch([201])
    await postForgeReview(
      { ...target, forge: 'forgejo', apiBase: 'https://code.example.org/' },
      report(),
      { toolVersion: '0.1.0', fetch },
    )
    const [call] = calls
    assert.ok(call)
    assert.equal(
      call.url,
      'https://code.example.org/api/v1/repos/copse-dev/agent-pane/pulls/42/reviews',
    )
    assert.equal(call.headers['Authorization'], 'token ghs_token')
    assert.deepEqual(call.body['comments'], [
      { path: 'src/math.ts', new_position: 4, body: renderFindingComment(anchored) },
    ])
  })

  it('keeps valid inline comments when another finding points outside the diff', async () => {
    for (const forge of ['github', 'forgejo'] as const) {
      const { fetch, calls } = fakeFetch([201])
      const readPaths: string[] = []
      const posted = await postForgeReview(
        { ...target, forge },
        report({
          findings: [{ ...unanchored, anchor: { path: 'package.json', startLine: 45 } }, anchored],
        }),
        {
          toolVersion: 'test',
          fetch,
          diffForPath: async (path) => {
            readPaths.push(path)
            return path === 'src/math.ts' ? mathDiff : ''
          },
        },
      )
      assert.deepEqual(posted, { inline: 1, folded: 1 })
      assert.deepEqual(readPaths.sort(), ['package.json', 'src/math.ts'])
      assert.equal(calls.length, 1, 'invalid anchors are folded before submission')
      const call = calls[0]
      assert.ok(call)
      assert.deepEqual(call.body['comments'], [
        forge === 'github'
          ? { path: 'src/math.ts', line: 4, side: 'RIGHT', body: renderFindingComment(anchored) }
          : { path: 'src/math.ts', new_position: 4, body: renderFindingComment(anchored) },
      ])
      assert.match(String(call.body['body']), /#### Issue 1\n\n`package\.json:45`/)
      assert.doesNotMatch(String(call.body['body']), /add subtracts/)
    }
  })

  it('folds inline comments into the body when the forge refuses their lines', async () => {
    const { fetch, calls } = fakeFetch([422, 200])
    const posted = await postForgeReview(target, report(), { toolVersion: '0.1.0', fetch })
    assert.deepEqual(posted, { inline: 0, folded: 1 })
    assert.equal(calls.length, 2)
    const retry = calls[1]
    assert.ok(retry)
    assert.deepEqual(retry.body['comments'], [])
    assert.match(
      String(retry.body['body']),
      /#### Issue 1\n\n`src\/math\.ts:3`\n\n\*\*add subtracts/,
    )
  })

  it('reports any other failure with the status and the response head', async () => {
    const { fetch } = fakeFetch([403])
    await assert.rejects(
      postForgeReview(target, report(), { toolVersion: '0.1.0', fetch }),
      (err: unknown) =>
        err instanceof ForgeReviewError && err.status === 403 && /returned 403/.test(err.message),
    )
    const { fetch: refused } = fakeFetch([422])
    await assert.rejects(
      postForgeReview(target, report({ findings: [] }), { toolVersion: '0.1.0', fetch: refused }),
      /returned 422/,
    )
  })
})

it('keeps reported hosting providers inside review details and does not infer missing hosts', () => {
  const base = report()
  const withHosts = buildForgeReview(
    {
      ...base,
      reviews: base.reviews.map((review) => ({ ...review, hostingProviders: ['Azure', 'OpenAI'] })),
    },
    { headCommit: target.headCommit, toolVersion: 'test' },
  )
  assert.match(withHosts.body, /Hosting providers reported by responses: Azure, OpenAI/)
  assert.ok(
    withHosts.body.indexOf('Hosting providers') >
      withHosts.body.indexOf('<summary>Review details</summary>'),
  )
  const withoutHosts = buildForgeReview(base, {
    headCommit: target.headCommit,
    toolVersion: 'test',
  })
  assert.match(withoutHosts.body, /Hosting provider: not reported by the service/)
})

describe('posting only what is new', () => {
  interface Call {
    readonly method: string
    readonly url: string
    readonly body: unknown
  }

  // A GitHub where PR #50 is open and already carries a bot comment raising
  // `anchored` in other words; a human quoted the same text on PR #51.
  function github(options: { failLookup?: boolean; humanOnly?: boolean } = {}): {
    fetch: FetchLike
    calls: Call[]
  } {
    const calls: Call[] = []
    const json = (value: unknown, status = 200): ReturnType<FetchLike> =>
      Promise.resolve({ status, text: () => Promise.resolve(JSON.stringify(value)) })
    // Rendered exactly as posted, with the claim worded as another run might word it.
    const raised = (claim: string, pr: number, type: string): Record<string, unknown> => ({
      path: 'src/math.ts',
      html_url: `https://github.com/copse-dev/agent-pane/pull/${String(pr)}#discussion_r1`,
      pull_request_url: `https://api.github.com/repos/copse-dev/agent-pane/pulls/${String(pr)}`,
      user: { type },
      body: renderFindingComment({ ...anchored, claim }),
    })
    const fetch: FetchLike = (url, init) => {
      calls.push({
        method: init.method,
        url,
        body: init.body === undefined ? undefined : JSON.parse(init.body),
      })
      if (init.method === 'GET' && url.includes('/pulls?state=open')) {
        return options.failLookup
          ? json({ message: 'nope' }, 500)
          : json([{ number: 50 }, { number: 51 }, { number: 42 }])
      }
      if (init.method === 'GET' && url.includes('/pulls/comments?')) {
        if (options.humanOnly === true) return json([raised(anchored.claim, 51, 'User')])
        return json([
          raised(
            'The add function subtracts its second argument rather than adding it.',
            50,
            'Bot',
          ),
          raised('Unrelated: the logger drops its last line on exit.', 50, 'Bot'),
          raised(unanchored.claim, 51, 'User'),
        ])
      }
      if (init.method === 'GET' && /\/pulls\/42\/reviews\?/.test(url)) {
        return json([
          {
            id: 1,
            user: { login: 'copse-bot[bot]', type: 'Bot' },
            body: `old <!-- copse-review:${'c'.repeat(40)} -->`,
          },
          {
            id: 2,
            user: { login: 'someone', type: 'User' },
            body: `quote <!-- copse-review:${'c'.repeat(40)} -->`,
          },
        ])
      }
      if (init.method === 'POST' && url.endsWith('/reviews')) {
        return json({
          id: 9,
          html_url: 'https://github.com/r/pull/42#pullrequestreview-9',
          user: { login: 'copse-bot[bot]' },
        })
      }
      return json([])
    }
    return { fetch, calls }
  }

  const post = (calls: readonly Call[]): Call | undefined =>
    calls.find((call) => call.method === 'POST' && call.url.endsWith('/pulls/42/reviews'))

  it('leaves out a finding another open pull request already raised, and says where', async () => {
    const { fetch, calls } = github()
    const posted = await postForgeReview(target, report(), {
      toolVersion: 'test',
      fetch,
      skipWhenEmpty: true,
      skipRaisedElsewhere: true,
      now: () => Date.parse('2026-09-25T18:00:00Z'),
    })
    assert.equal(posted.repeatedElsewhere, 1)
    assert.equal(posted.notPosted, undefined)
    const body = JSON.stringify(post(calls)?.body)
    assert.doesNotMatch(body, /add subtracts/, 'the repeated finding is not posted again')
    assert.match(body, /pnpm run test/, 'an unrelated finding is kept')
    assert.match(body, /1 more already raised on \[#50\]/)
    assert.ok(calls.some((call) => call.url.includes('since=2026-08-26T18:00:00.000Z')))
  })

  it('posts nothing when nothing is left, and marks earlier reviews resolved only after a complete run', async () => {
    const complete = github()
    const onlyRepeated = report({ findings: [anchored] })
    const resolved = await postForgeReview(target, onlyRepeated, {
      toolVersion: 'test',
      fetch: complete.fetch,
      skipWhenEmpty: true,
      skipRaisedElsewhere: true,
    })
    assert.equal(resolved.notPosted, 'no findings')
    assert.equal(post(complete.calls), undefined)
    assert.equal(resolved.superseded, 1)
    const edits = complete.calls.filter((call) => call.method === 'PUT')
    assert.deepEqual(
      edits.map((call) => call.url.split('/').pop()),
      ['1'],
      'only the bot review',
    )
    assert.match(
      JSON.stringify(edits[0]?.body),
      /Resolved: a newer review of `b{12}` raised no new issues/,
    )

    const failed = github()
    const incomplete = report({
      findings: [],
      reviews: report().reviews.map((review) => ({ ...review, outcome: 'failed' })),
    })
    const kept = await postForgeReview(target, incomplete, {
      toolVersion: 'test',
      fetch: failed.fetch,
      skipWhenEmpty: true,
    })
    assert.equal(kept.notPosted, 'no findings')
    assert.equal(kept.superseded, undefined)
    assert.deepEqual(failed.calls, [], 'a failed run neither posts nor hides earlier findings')
  })

  it("never lets a person's comment suppress a finding, however closely it quotes one", async () => {
    const { fetch, calls } = github({ humanOnly: true })
    const posted = await postForgeReview(target, report(), {
      toolVersion: 'test',
      fetch,
      skipRaisedElsewhere: true,
    })
    assert.equal(posted.repeatedElsewhere, undefined)
    assert.match(JSON.stringify(post(calls)?.body), /add subtracts/)
  })

  it('keeps every finding when the lookup of other pull requests fails', async () => {
    const { fetch, calls } = github({ failLookup: true })
    const posted = await postForgeReview(target, report(), {
      toolVersion: 'test',
      fetch,
      skipRaisedElsewhere: true,
    })
    assert.match(posted.repeatLookupError ?? '', /500/)
    assert.match(JSON.stringify(post(calls)?.body), /add subtracts/)
  })
})
