import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import { z } from 'zod'

// Exercise the scripts Actions actually executes, including their API decisions.
const stepsSchema = z.array(
  z.object({
    name: z.string().optional(),
    id: z.string().optional(),
    uses: z.string().optional(),
    if: z.string().optional(),
    'continue-on-error': z.boolean().optional(),
    env: z.record(z.string(), z.string()).optional(),
    run: z.string().optional(),
    with: z.record(z.string(), z.unknown()).optional(),
  }),
)
const steps = z
  .object({ jobs: z.object({ publish: z.object({ steps: stepsSchema }) }) })
  .parse(load(readFileSync('.github/workflows/publish-screenshot-candidates.yml', 'utf8'))).jobs
  .publish.steps
const closeSteps = z
  .object({ jobs: z.object({ close: z.object({ steps: stepsSchema }) }) })
  .parse(load(readFileSync('.github/workflows/close-orphaned-screenshot-reviews.yml', 'utf8'))).jobs
  .close.steps

async function runScript(script: unknown, bindings: Record<string, unknown>): Promise<void> {
  const source = z.string().parse(script)
  assert.doesNotMatch(source, /\$\{\{/)
  const execution: unknown = runInNewContext(`(async () => {\n${source}\n})()`, bindings)
  await execution
}

async function execute(name: string, bindings: Record<string, unknown>): Promise<void> {
  await runScript(steps.find((candidate) => candidate.name === name)?.with?.['script'], bindings)
}

// A full object id: the discovery step refuses anything else before deriving refs.
const SHA = 'abc123abc123abc123abc123abc123abc123abc1'
const COMPARE_BRANCH = 'screenshot-compare/pr-123/abc123abc123'
const COMPARE_URL = `https://github.com/copse-dev/agent-pane/compare/${SHA}...${COMPARE_BRANCH}`
const COMPARE_COMMIT = 'def456def456def456def456def456def456def4'
const RAW = 'https://github.com/copse-dev/agent-pane/raw'

function candidateNames(entries: { name: string; new: boolean }[]): string {
  return JSON.stringify(entries)
}

interface Parent {
  state: string
  labels: { name: string }[]
  head: { ref: string; sha: string; repo: { full_name: string } }
}

function parent(
  overrides: { labels?: string[]; sha?: string; state?: string; repo?: string; ref?: string } = {},
): Parent {
  return {
    state: overrides.state ?? 'open',
    labels: (overrides.labels ?? []).map((name) => ({ name })),
    head: {
      ref: overrides.ref ?? 'codex/feature',
      sha: overrides.sha ?? SHA,
      repo: { full_name: overrides.repo ?? 'copse-dev/agent-pane' },
    },
  }
}

const core = { notice: (): void => {}, setFailed: assert.fail }
const context = {
  repo: { owner: 'copse-dev', repo: 'agent-pane' },
  payload: { workflow_run: { pull_requests: [{ number: 123 }] } },
}

async function discover(
  liveParent = parent(),
  artifacts = [{ id: 42, name: 'reference-screenshot-candidates-99', expired: false }],
  runHeadSha = SHA,
  setFailed: (message: string) => void = assert.fail,
): Promise<Map<string, string>> {
  const outputs = new Map<string, string>()
  await execute('Resolve the live parent PR and exact artifact', {
    context,
    process: { env: { RUN_ID: '99', RUN_HEAD_SHA: runHeadSha } },
    core: {
      ...core,
      setFailed,
      setOutput: (key: string, value: string) => outputs.set(key, value),
    },
    github: {
      rest: {
        pulls: { get: async () => ({ data: liveParent }) },
        actions: { listWorkflowRunArtifacts: () => {} },
      },
      paginate: async () => artifacts,
    },
  })
  return outputs
}

describe('screenshot publication', () => {
  it('retains evidence without requesting a child PR for ordinary runs', async () => {
    const outputs = await discover()
    assert.equal(outputs.get('eligible'), 'true')
    assert.equal(outputs.get('has-artifact'), 'true')
    assert.equal(outputs.get('artifact-id'), '42')
    assert.equal(outputs.get('create-review'), 'false')
    assert.equal(outputs.get('compare-branch'), COMPARE_BRANCH)
    assert.equal(outputs.get('review-branch'), 'screenshots/pr-123/abc123abc123')
  })

  it('refuses to derive bot refs from anything but a full hex head SHA', async () => {
    for (const runHeadSha of ['', 'abc123', `${SHA.slice(0, 39)}/`, SHA.toUpperCase()]) {
      const failures: string[] = []
      const outputs = await discover(
        parent({ sha: runHeadSha }),
        undefined,
        runHeadSha,
        (message) => {
          failures.push(message)
        },
      )
      assert.equal(failures.length, 1, runHeadSha)
      assert.equal(outputs.get('eligible'), 'false')
      assert.equal(outputs.has('compare-branch'), false)
    }
  })

  it('preserves a requested review on a same-head rerun after label removal, and closes older reviews', async () => {
    const outputs = new Map<string, string>()
    const closed: number[] = []
    await execute('Close superseded screenshot review PRs', {
      context,
      core: {
        ...core,
        info: () => {},
        setOutput: (key: string, value: string) => outputs.set(key, value),
      },
      process: {
        env: {
          PARENT_NUMBER: '123',
          BASE_REF: 'codex/feature',
          REVIEW_BRANCH: 'screenshots/pr-123/abc123',
          EXPECTED_HEAD_SHA: SHA,
        },
      },
      github: {
        rest: {
          pulls: {
            get: async () => ({ data: parent() }),
            list: () => {},
            update: async ({ pull_number }: { pull_number: number }) => {
              closed.push(pull_number)
            },
          },
        },
        paginate: async () => [
          {
            number: 456,
            html_url: 'https://github.com/copse-dev/agent-pane/pull/456',
            head: { ref: 'screenshots/pr-123/abc123', repo: { full_name: 'copse-dev/agent-pane' } },
          },
          {
            number: 455,
            head: {
              ref: 'screenshots/pr-123/old-sha',
              repo: { full_name: 'copse-dev/agent-pane' },
            },
          },
          {
            number: 789,
            head: { ref: 'screenshots/pr-789/abc123', repo: { full_name: 'copse-dev/agent-pane' } },
          },
        ],
      },
    })
    assert.deepEqual(closed, [455])
    assert.equal(outputs.get('existing-number'), '456')
    assert.equal(outputs.get('existing-url'), 'https://github.com/copse-dev/agent-pane/pull/456')
  })

  it('does not let a stale publisher close reviews belonging to a newer head', async () => {
    await execute('Close superseded screenshot review PRs', {
      context,
      core,
      process: { env: { PARENT_NUMBER: '123', EXPECTED_HEAD_SHA: SHA } },
      github: {
        rest: { pulls: { get: async () => ({ data: parent({ sha: 'new-tip' }) }) } },
        paginate: assert.fail,
      },
    })
  })

  it('creates a review only for an explicit refresh with an unexpired artifact', async () => {
    assert.equal(
      (await discover(parent({ labels: ['update-screenshots'] }))).get('create-review'),
      'true',
    )
    assert.equal((await discover(parent({ labels: ['ci-full'] }))).get('create-review'), 'false')
    for (const artifacts of [
      [],
      [{ id: 42, name: 'reference-screenshot-candidates-99', expired: true }],
    ]) {
      const outputs = await discover(parent({ labels: ['update-screenshots'] }), artifacts)
      assert.equal(outputs.get('has-artifact'), 'false')
      assert.equal(outputs.get('create-review'), 'false')
    }
  })

  it('does not publish evidence or reviews for stale, closed, external, or integration parents', async () => {
    for (const overrides of [
      { sha: 'new-tip' },
      { state: 'closed' },
      { repo: 'fork/agent-pane' },
      { ref: 'main' },
      { ref: 'release' },
    ]) {
      const outputs = await discover(parent({ ...overrides, labels: ['update-screenshots'] }))
      assert.equal(outputs.get('eligible'), 'false')
      assert.equal(outputs.get('create-review'), 'false')
    }
  })

  it('gates only token minting and PR creation on the explicit request', () => {
    const byId = (id: string): (typeof steps)[number] | undefined =>
      steps.find((step) => step.id === id)
    for (const id of ['app-token', 'review-pr'])
      assert.equal(byId(id)?.if, "steps.discover.outputs.create-review == 'true'")
    const artifactSteps = steps.filter(
      (step) =>
        ['candidates', 'compare'].includes(step.id ?? '') ||
        ['actions/checkout@v7.0.1', 'actions/download-artifact@v8'].includes(step.uses ?? ''),
    )
    assert.equal(artifactSteps.length, 4)
    for (const step of artifactSteps)
      assert.equal(step.if, "steps.discover.outputs.has-artifact == 'true'")
    for (const name of [
      'Close superseded screenshot review PRs',
      'Delete superseded screenshot compare branches',
      'Link screenshot evidence from the parent',
    ]) {
      const step = steps.find((candidate) => candidate.name === name)
      assert.ok(step)
      assert.equal(step.if, "steps.discover.outputs.eligible == 'true'")
      assert.equal(
        step.with?.['github-token'],
        undefined,
        'artifact-only publication must not depend on an App token',
      )
    }
  })

  it('pushes the compare branch with the job token after validation, without blocking publication', () => {
    const index = (predicate: (step: (typeof steps)[number]) => boolean): number =>
      steps.findIndex(predicate)
    const compare = steps[index((step) => step.id === 'compare')]
    assert.ok(compare)
    assert.ok(index((step) => step.id === 'candidates') < index((step) => step.id === 'compare'))
    assert.ok(index((step) => step.id === 'compare') < index((step) => step.id === 'review-pr'))
    assert.equal(compare['continue-on-error'], true)
    assert.equal(compare.env?.['PUSH_TOKEN'], '${{ github.token }}')
    assert.doesNotMatch(JSON.stringify(compare), /app-token|secrets\./)
    assert.match(compare.run ?? '', /git commit-tree "\$tree" -p HEAD/)
    assert.match(compare.run ?? '', /"\$commit:refs\/heads\/\$COMPARE_BRANCH"/)
    assert.doesNotMatch(compare.run ?? '', /git (?:config|commit |checkout|remote)/)
    assert.doesNotMatch(compare.run ?? '', /\$\{\{/)
    const checkout = steps.find((step) => step.uses === 'actions/checkout@v7.0.1')
    assert.ok(checkout?.with)
    assert.equal(checkout.with['persist-credentials'], false)
    assert.equal(
      checkout.with['fetch-depth'],
      "${{ steps.discover.outputs.create-review == 'true' && '0' || '1' }}",
      'the view-only path must not fetch the full PNG history',
    )
  })
})

async function cleanUpCompareBranches(
  env: Record<string, string> = {},
  liveParent = parent(),
  refs = [
    `refs/heads/${COMPARE_BRANCH}`,
    'refs/heads/screenshot-compare/pr-123/000000000000',
    'refs/heads/screenshot-compare/pr-123/111111111111',
  ],
): Promise<{ deleted: string[]; listed: string[]; failures: string[] }> {
  const deleted: string[] = []
  const listed: string[] = []
  const failures: string[] = []
  const listMatchingRefs = (): void => {}
  await execute('Delete superseded screenshot compare branches', {
    context,
    core: {
      ...core,
      info: () => {},
      setFailed: (message: string) => {
        failures.push(message)
      },
    },
    process: {
      env: {
        PARENT_NUMBER: '123',
        EXPECTED_HEAD_SHA: SHA,
        COMPARE_BRANCH,
        COMPARE_PUSHED: 'true',
        ...env,
      },
    },
    github: {
      rest: {
        pulls: { get: async () => ({ data: liveParent }) },
        git: {
          listMatchingRefs,
          deleteRef: async ({ ref }: { ref: string }) => {
            deleted.push(ref)
            // A concurrent deletion must not stop the rest of the cleanup.
            if (ref.endsWith('000000000000')) throw new Error('Reference does not exist')
          },
        },
      },
      paginate: async (method: unknown, params: { ref: string }) => {
        assert.equal(method, listMatchingRefs)
        listed.push(params.ref)
        return refs.map((ref) => ({ ref }))
      },
    },
  })
  return { deleted, listed, failures }
}

describe('screenshot compare branch cleanup', () => {
  it('deletes only superseded branches for the same parent while it is live at the expected head', async () => {
    const result = await cleanUpCompareBranches(undefined, undefined, [
      `refs/heads/${COMPARE_BRANCH}`,
      'refs/heads/screenshot-compare/pr-123/000000000000',
      'refs/heads/screenshot-compare/pr-123/111111111111',
      'refs/heads/screenshot-compare/pr-1234/222222222222',
      'refs/heads/screenshots/pr-123/333333333333',
    ])
    assert.deepEqual(result, {
      listed: ['heads/screenshot-compare/pr-123/'],
      deleted: [
        'heads/screenshot-compare/pr-123/000000000000',
        'heads/screenshot-compare/pr-123/111111111111',
      ],
      failures: [],
    })
  })

  it('keeps the same-head branch even when this run pushed nothing new', async () => {
    const { deleted } = await cleanUpCompareBranches({ COMPARE_PUSHED: '' })
    assert.equal(deleted.includes(`heads/${COMPARE_BRANCH}`), false)
    assert.equal(deleted.length, 2)
  })

  it('deletes only the just-pushed branch when the parent moved or closed', async () => {
    for (const liveParent of [parent({ sha: 'new-tip' }), parent({ state: 'closed' })]) {
      const result = await cleanUpCompareBranches(undefined, liveParent)
      assert.deepEqual(result, { deleted: [`heads/${COMPARE_BRANCH}`], listed: [], failures: [] })
    }
    const unpushed = await cleanUpCompareBranches(
      { COMPARE_PUSHED: '' },
      parent({ sha: 'new-tip' }),
    )
    assert.deepEqual(unpushed, { deleted: [], listed: [], failures: [] })
  })

  it('refuses a compare branch outside the parent prefix', async () => {
    for (const env of [
      { COMPARE_BRANCH: 'screenshot-compare/pr-1234/abc123abc123' },
      { COMPARE_BRANCH: 'main' },
      { PARENT_NUMBER: 'abc' },
    ]) {
      const result = await cleanUpCompareBranches(env)
      assert.deepEqual(result.deleted, [])
      assert.equal(result.failures.length, 1)
    }
  })
})

async function publish(
  env: Record<string, string> = {},
  liveParent = parent(),
  previous = false,
): Promise<{ bodies: string[]; closed: number[]; deleted: string[] }> {
  const bodies: string[] = []
  const closed: number[] = []
  const deleted: string[] = []
  const recordBody = async ({ body }: { body: string }): Promise<void> => {
    bodies.push(body)
  }
  await execute('Link screenshot evidence from the parent', {
    context,
    core,
    process: {
      env: {
        PARENT_NUMBER: '123',
        EXPECTED_HEAD_SHA: SHA,
        HEAD_REF: 'codex/feature',
        ARTIFACT_ID: '42',
        COMPARE_BRANCH,
        COMPARE_PUSHED: 'true',
        COMPARE_COMMIT,
        CANDIDATE_NAMES: candidateNames([
          { name: 'b-new.png', new: true },
          { name: 'a-changed.png', new: false },
        ]),
        CANDIDATE_COUNT: '2',
        RUN_ID: '99',
        RUN_URL: 'https://github.com/copse-dev/agent-pane/actions/runs/99',
        ...env,
      },
    },
    github: {
      rest: {
        pulls: {
          get: async () => ({ data: liveParent }),
          update: async ({ pull_number }: { pull_number: number }) => {
            closed.push(pull_number)
          },
        },
        git: {
          deleteRef: async ({ ref }: { ref: string }) => {
            deleted.push(ref)
          },
        },
        issues: { listComments: () => {}, updateComment: recordBody, createComment: recordBody },
      },
      paginate: async () =>
        previous
          ? [{ id: 7, user: { type: 'Bot' }, body: '<!-- copse-e2e-screenshot-review -->' }]
          : [],
    },
  })
  return { bodies, closed, deleted }
}

describe('parent screenshot evidence comment', () => {
  it('links the compare view first, keeps the artifact, and explains how to accept references', async () => {
    const { bodies } = await publish()
    assert.equal(bodies.length, 1)
    const body = bodies[0] ?? ''
    assert.ok(body.includes(`](${COMPARE_URL})`), body)
    assert.ok(body.indexOf(COMPARE_URL) < body.indexOf('actions/runs/99/artifacts/42'))
    assert.match(body, /for viewing only/)
    assert.match(body, /Accepting references still needs `update-screenshots` or a manual commit/)
    assert.match(body, /actions\/runs\/99\/artifacts\/42/)
    assert.match(body, /abc123abc123/)
    assert.match(body, /14 days/)
    assert.match(body, /No baseline-update PR was opened/)
    assert.match(body, /add `update-screenshots`/)
    assert.match(body, /Do not refresh references merely to absorb unrelated rendering drift/)
  })

  it('previews before and after images pinned to immutable commits', async () => {
    const body = (await publish()).bodies[0] ?? ''
    const rows = body.split('\n').filter((line) => line.startsWith('| '))
    assert.deepEqual(rows, [
      '| Screenshot | Before | After |',
      '| --- | --- | --- |',
      `| \`a-changed.png\` | <img src="${RAW}/${SHA}/tests/e2e/screenshots/a-changed.png" width="360"> | ` +
        `<img src="${RAW}/${COMPARE_COMMIT}/tests/e2e/screenshots/a-changed.png" width="360"> |`,
      `| \`b-new.png\` | *new* | ` +
        `<img src="${RAW}/${COMPARE_COMMIT}/tests/e2e/screenshots/b-new.png" width="360"> |`,
    ])
    assert.doesNotMatch(
      body,
      /\/raw\/screenshot-compare/,
      'raw URLs must never name the mutable branch',
    )
    assert.doesNotMatch(body, /and \d+ more/)
    assert.ok(body.indexOf('| Screenshot |') < body.indexOf('actions/runs/99/artifacts/42'))
  })

  it('caps the preview at 20 sorted rows and points the rest at the compare view', async () => {
    const entries = Array.from({ length: 25 }, (_, index) => ({
      name: `shot-${String(24 - index).padStart(2, '0')}.png`,
      new: index % 2 === 0,
    }))
    const body =
      (await publish({ CANDIDATE_NAMES: candidateNames(entries), CANDIDATE_COUNT: '60' }))
        .bodies[0] ?? ''
    const names = body
      .split('\n')
      .filter((line) => line.startsWith('| `'))
      .map((line) => /^\| `([^`]+)`/.exec(line)?.[1])
    assert.deepEqual(
      names,
      Array.from({ length: 20 }, (_, index) => `shot-${String(index).padStart(2, '0')}.png`),
    )
    assert.ok(body.includes(`…and 40 more — see [the compare view](${COMPARE_URL}).`), body)
  })

  it('keeps the comment far below GitHub’s size limit with the longest allowed names', async () => {
    const entries = Array.from({ length: 50 }, (_, index) => ({
      name: `${String(index).padStart(2, '0')}${'x'.repeat(240)}.png`,
      new: false,
    }))
    for (const env of [
      {},
      { REVIEW_NUMBER: '456', REVIEW_URL: 'https://github.com/copse-dev/agent-pane/pull/456' },
    ]) {
      const body =
        (
          await publish({
            ...env,
            CANDIDATE_NAMES: candidateNames(entries),
            CANDIDATE_COUNT: '2048',
          })
        ).bodies[0] ?? ''
      assert.equal(body.split('\n').filter((line) => line.startsWith('| `')).length, 20)
      assert.ok(body.length < 32_768, String(body.length))
    }
  })

  it('omits the preview rather than render unvalidated names or a mutable after-ref', async () => {
    for (const env of [
      { CANDIDATE_NAMES: candidateNames([{ name: '<script>.png', new: false }]) },
      {
        CANDIDATE_NAMES: candidateNames([
          { name: 'a.png', new: false },
          { name: '../x.png', new: true },
        ]),
      },
      { CANDIDATE_NAMES: '[{"name":"a.png","new":"yes"}]' },
      { CANDIDATE_NAMES: 'not json' },
      { CANDIDATE_NAMES: '' },
      { COMPARE_COMMIT: COMPARE_BRANCH },
      { COMPARE_COMMIT: '' },
    ]) {
      const body = (await publish(env)).bodies[0] ?? ''
      assert.doesNotMatch(body, /\| Screenshot \||<img/, JSON.stringify(env))
      assert.ok(body.includes(COMPARE_URL))
    }
  })

  it('passes candidate names to the comment through env, never the script text', () => {
    const step = steps.find(
      (candidate) => candidate.name === 'Link screenshot evidence from the parent',
    )
    assert.ok(step?.env)
    assert.equal(step.env['CANDIDATE_NAMES'], '${{ steps.candidates.outputs.names }}')
    assert.equal(step.env['CANDIDATE_COUNT'], '${{ steps.candidates.outputs.count }}')
    assert.equal(step.env['COMPARE_COMMIT'], '${{ steps.compare.outputs.commit }}')
    assert.doesNotMatch(z.string().parse(step.with?.['script']), /\$\{\{/)
  })

  it('falls back to the artifact alone when no compare branch was pushed', async () => {
    const { bodies } = await publish({ COMPARE_PUSHED: '' })
    assert.match(bodies[0] ?? '', /Changed reference candidates for `abc123abc123` are in/)
    assert.match(bodies[0] ?? '', /actions\/runs\/99\/artifacts\/42/)
    assert.doesNotMatch(bodies[0] ?? '', /compare/)
  })

  it('links an explicitly requested PNG review without recommending automatic acceptance', async () => {
    const { bodies } = await publish({
      REVIEW_NUMBER: '456',
      REVIEW_URL: 'https://github.com/copse-dev/agent-pane/pull/456',
    })
    assert.match(bodies[0] ?? '', /screenshot PR #456/)
    assert.match(bodies[0] ?? '', /Remove `update-screenshots`/)
    assert.ok((bodies[0] ?? '').includes(`[view-only compare](${COMPARE_URL})`))
    assert.ok(
      (bodies[0] ?? '').includes(`${RAW}/${COMPARE_COMMIT}/tests/e2e/screenshots/b-new.png`),
    )
    assert.doesNotMatch(bodies[0] ?? '', /auto-merge/)
  })

  it('keeps a same-head review linked after the refresh label is removed', async () => {
    const { bodies } = await publish({
      EXISTING_REVIEW_NUMBER: '456',
      EXISTING_REVIEW_URL: 'https://github.com/copse-dev/agent-pane/pull/456',
    })
    assert.match(bodies[0] ?? '', /screenshot PR #456/)
    assert.match(bodies[0] ?? '', /records its source run/)
    assert.doesNotMatch(bodies[0] ?? '', /No baseline-update PR was opened/)
  })

  it('closes a just-created review when the parent advances, without posting stale evidence', async () => {
    const result = await publish({ REVIEW_NUMBER: '456' }, parent({ sha: 'new-tip' }))
    assert.deepEqual(result, { bodies: [], closed: [456], deleted: [`heads/${COMPARE_BRANCH}`] })
  })

  it('deletes the just-pushed compare branch and posts no stale link when the parent advances', async () => {
    const result = await publish({}, parent({ sha: 'new-tip' }), true)
    assert.deepEqual(result, { bodies: [], closed: [], deleted: [`heads/${COMPARE_BRANCH}`] })
    const unpushed = await publish({ COMPARE_PUSHED: '' }, parent({ state: 'closed' }), true)
    assert.deepEqual(unpushed, { bodies: [], closed: [], deleted: [] })
  })

  it('does not add no-change comments, but replaces an older evidence comment', async () => {
    assert.deepEqual((await publish({ ARTIFACT_ID: '' })).bodies, [])
    const { bodies } = await publish({ ARTIFACT_ID: '' }, parent(), true)
    assert.match(bodies[0] ?? '', /no filtered screenshot candidates/)
  })
})

async function closeParent(
  pulls: { number: number; head: { ref: string; repo: { full_name: string } } }[],
  refs: string[],
): Promise<{ closed: number[]; deleted: string[]; comments: number[] }> {
  const closed: number[] = []
  const deleted: string[] = []
  const comments: number[] = []
  const list = (): void => {}
  const listMatchingRefs = (): void => {}
  const script = closeSteps.find((step) => step.uses === 'actions/github-script@v9')?.with?.[
    'script'
  ]
  await runScript(script, {
    context,
    core: { ...core, info: () => {} },
    process: { env: { PARENT_NUMBER: '123' } },
    github: {
      rest: {
        pulls: {
          list,
          update: async ({ pull_number }: { pull_number: number }) => {
            closed.push(pull_number)
          },
        },
        issues: {
          createComment: async ({ issue_number }: { issue_number: number }) => {
            comments.push(issue_number)
          },
        },
        git: {
          listMatchingRefs,
          deleteRef: async ({ ref }: { ref: string }) => {
            deleted.push(ref)
            if (ref.endsWith('000000000000')) throw new Error('Reference does not exist')
          },
        },
      },
      paginate: async (method: unknown, params: { ref?: string }) => {
        if (method === listMatchingRefs) {
          assert.equal(params.ref, 'heads/screenshot-compare/pr-123/')
          return refs.map((ref) => ({ ref }))
        }
        assert.equal(method, list)
        return pulls
      },
    },
  })
  return { closed, deleted, comments }
}

describe('closing a screenshot parent', () => {
  const repo = { full_name: 'copse-dev/agent-pane' }

  it('deletes every compare branch for the parent even when no review PR is open', async () => {
    const result = await closeParent(
      [{ number: 789, head: { ref: 'screenshots/pr-789/abc123abc123', repo } }],
      [
        'refs/heads/screenshot-compare/pr-123/000000000000',
        'refs/heads/screenshot-compare/pr-123/abc123abc123',
        'refs/heads/screenshot-compare/pr-1234/abc123abc123',
      ],
    )
    assert.deepEqual(result, {
      closed: [],
      comments: [],
      deleted: [
        'heads/screenshot-compare/pr-123/000000000000',
        'heads/screenshot-compare/pr-123/abc123abc123',
      ],
    })
  })

  it('still closes orphaned review PRs and deletes their branches', async () => {
    const result = await closeParent(
      [
        { number: 456, head: { ref: 'screenshots/pr-123/abc123abc123', repo } },
        {
          number: 457,
          head: { ref: 'screenshots/pr-123/abc123abc123', repo: { full_name: 'fork/agent-pane' } },
        },
      ],
      ['refs/heads/screenshot-compare/pr-123/abc123abc123'],
    )
    assert.deepEqual(result, {
      closed: [456],
      comments: [456],
      deleted: [
        'heads/screenshot-compare/pr-123/abc123abc123',
        'heads/screenshots/pr-123/abc123abc123',
      ],
    })
  })
})
