import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import { z } from 'zod'

// Exercise the scripts Actions actually executes, including their API decisions.
const workflow = z
  .object({
    jobs: z.object({
      publish: z.object({
        steps: z.array(
          z.object({
            name: z.string().optional(),
            id: z.string().optional(),
            uses: z.string().optional(),
            if: z.string().optional(),
            with: z.record(z.string(), z.unknown()).optional(),
          }),
        ),
      }),
    }),
  })
  .parse(load(readFileSync('.github/workflows/publish-screenshot-candidates.yml', 'utf8')))
const steps = workflow.jobs.publish.steps

async function execute(name: string, bindings: Record<string, unknown>): Promise<void> {
  const step = steps.find((candidate) => candidate.name === name)
  const script = z.string().parse(step?.with?.['script'])
  assert.doesNotMatch(script, /\$\{\{/)
  const execution: unknown = runInNewContext(`(async () => {\n${script}\n})()`, bindings)
  await execution
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
      sha: overrides.sha ?? 'abc123',
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
): Promise<Map<string, string>> {
  const outputs = new Map<string, string>()
  await execute('Resolve the live parent PR and exact artifact', {
    context,
    process: { env: { RUN_ID: '99', RUN_HEAD_SHA: 'abc123' } },
    core: { ...core, setOutput: (key: string, value: string) => outputs.set(key, value) },
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
          EXPECTED_HEAD_SHA: 'abc123',
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
      process: { env: { PARENT_NUMBER: '123', EXPECTED_HEAD_SHA: 'abc123' } },
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

  it('gates token minting, checkout, artifact application, and PR creation on the explicit request', () => {
    const ids = ['app-token', 'candidates', 'review-pr']
    const uses = ['actions/checkout@v7.0.1', 'actions/download-artifact@v8']
    const gated = steps.filter(
      (step) => ids.includes(step.id ?? '') || uses.includes(step.uses ?? ''),
    )
    assert.equal(gated.length, 5)
    for (const step of gated)
      assert.equal(step.if, "steps.discover.outputs.create-review == 'true'")
    for (const name of [
      'Close superseded screenshot review PRs',
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
})

async function publish(
  env: Record<string, string> = {},
  liveParent = parent(),
  previous = false,
): Promise<{ bodies: string[]; closed: number[] }> {
  const bodies: string[] = []
  const closed: number[] = []
  const recordBody = async ({ body }: { body: string }): Promise<void> => {
    bodies.push(body)
  }
  await execute('Link screenshot evidence from the parent', {
    context,
    core,
    process: {
      env: {
        PARENT_NUMBER: '123',
        EXPECTED_HEAD_SHA: 'abc123',
        HEAD_REF: 'codex/feature',
        ARTIFACT_ID: '42',
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
        issues: { listComments: () => {}, updateComment: recordBody, createComment: recordBody },
      },
      paginate: async () =>
        previous
          ? [{ id: 7, user: { type: 'Bot' }, body: '<!-- copse-e2e-screenshot-review -->' }]
          : [],
    },
  })
  return { bodies, closed }
}

describe('parent screenshot evidence comment', () => {
  it('links the immutable artifact and explains how to request reviewed baseline updates', async () => {
    const { bodies } = await publish()
    assert.equal(bodies.length, 1)
    assert.match(bodies[0] ?? '', /actions\/runs\/99\/artifacts\/42/)
    assert.match(bodies[0] ?? '', /abc123/)
    assert.match(bodies[0] ?? '', /14 days/)
    assert.match(bodies[0] ?? '', /No baseline-update PR was opened/)
    assert.match(bodies[0] ?? '', /add `update-screenshots`/)
  })

  it('links an explicitly requested PNG review without recommending automatic acceptance', async () => {
    const { bodies } = await publish({
      REVIEW_NUMBER: '456',
      REVIEW_URL: 'https://github.com/copse-dev/agent-pane/pull/456',
    })
    assert.match(bodies[0] ?? '', /screenshot PR #456/)
    assert.match(bodies[0] ?? '', /Remove `update-screenshots`/)
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
    assert.deepEqual(result, { bodies: [], closed: [456] })
  })

  it('does not add no-change comments, but replaces an older evidence comment', async () => {
    assert.deepEqual((await publish({ ARTIFACT_ID: '' })).bodies, [])
    const { bodies } = await publish({ ARTIFACT_ID: '' }, parent(), true)
    assert.match(bodies[0] ?? '', /no filtered screenshot candidates/)
  })
})
