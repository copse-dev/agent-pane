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

interface Call {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

function fakeFetch(statuses: number[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const queue = [...statuses]
  const fetch: FetchLike = (url, init) => {
    const body: unknown = JSON.parse(init.body)
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
    assert.match(review.body, /#### package\.json\n\n\*\*`pnpm run test`/)
    assert.doesNotMatch(
      review.body,
      /add subtracts/,
      'the inline finding is not repeated in the body',
    )
    assert.match(review.body, /this review does not block merging/)
    assert.match(review.body, /<!-- copse-review:b{40} -->/)
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

  it('folds inline comments into the body when the forge refuses their lines', async () => {
    const { fetch, calls } = fakeFetch([422, 200])
    const posted = await postForgeReview(target, report(), { toolVersion: '0.1.0', fetch })
    assert.deepEqual(posted, { inline: 0, folded: 1 })
    assert.equal(calls.length, 2)
    const retry = calls[1]
    assert.ok(retry)
    assert.deepEqual(retry.body['comments'], [])
    assert.match(String(retry.body['body']), /#### src\/math\.ts:3\n\n\*\*add subtracts/)
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
