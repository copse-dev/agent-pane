import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import { z } from 'zod'

// Exercise the scripts Actions actually executes against a stubbed REST API.
const source = readFileSync('.github/workflows/screenshot-review-labels.yml', 'utf8')
const workflow = z
  .object({
    on: z.object({ pull_request: z.object({ types: z.array(z.string()) }) }),
    permissions: z.record(z.string(), z.string()),
    jobs: z.object({
      decide: z.object({
        if: z.string(),
        permissions: z.record(z.string(), z.string()),
        steps: z.array(
          z.object({
            name: z.string().optional(),
            id: z.string().optional(),
            uses: z.string().optional(),
            if: z.string().optional(),
            'continue-on-error': z.boolean().optional(),
            env: z.record(z.string(), z.string()).optional(),
            with: z.record(z.string(), z.unknown()).optional(),
          }),
        ),
      }),
    }),
  })
  .parse(load(source))
const steps = workflow.jobs.decide.steps

async function execute(name: string, bindings: Record<string, unknown>): Promise<void> {
  const script = z.string().parse(steps.find((step) => step.name === name)?.with?.['script'])
  assert.doesNotMatch(script, /\$\{\{/)
  const execution: unknown = runInNewContext(`(async () => {\n${script}\n})()`, bindings)
  await execution
}

const HEAD = 'abc123abc123abc123abc123abc123abc123abc1'
const COMPARE = 'def456def456def456def456def456def456def4'
const BRANCH = 'screenshot-compare/pr-123/abc123abc123'
const context = { repo: { owner: 'copse-dev', repo: 'agent-pane' } }

interface Entry {
  path: string
  mode: string
  type: string
  sha: string
}
const blob = (path: string, sha: string): Entry => ({ path, mode: '100644', type: 'blob', sha })
const tree = (path: string, sha: string): Entry => ({ path, mode: '040000', type: 'tree', sha })

// Head and compare trees that differ only by one changed and one added PNG.
function trees(
  changes: { root?: Entry[]; e2e?: Entry[]; shots?: Entry[] } = {},
): Map<string, Entry[]> {
  return new Map([
    ['head-root', [blob('package.json', 'p1'), tree('src', 's1'), tree('tests', 'head-tests')]],
    ['head-tests', [tree('e2e', 'head-e2e'), tree('unit', 'u1')]],
    ['head-e2e', [blob('pane.e2e.ts', 'e1'), tree('screenshots', 'head-shots')]],
    ['head-shots', [blob('a.png', 'a1'), blob('b.png', 'b1')]],
    [
      'compare-root',
      changes.root ?? [
        blob('package.json', 'p1'),
        tree('src', 's1'),
        tree('tests', 'compare-tests'),
      ],
    ],
    ['compare-tests', [tree('e2e', 'compare-e2e'), tree('unit', 'u1')]],
    [
      'compare-e2e',
      changes.e2e ?? [blob('pane.e2e.ts', 'e1'), tree('screenshots', 'compare-shots')],
    ],
    [
      'compare-shots',
      changes.shots ?? [blob('a.png', 'a2'), blob('b.png', 'b1'), blob('c.png', 'c1')],
    ],
  ])
}

interface Scenario {
  label?: string
  pr?: { state?: string; repo?: string; sha?: string }
  statuses?: { context: string; state: string; description: string }[]
  compareRef?: string | null
  parents?: string[]
  trees?: Map<string, Entry[]>
}

async function validate(scenario: Scenario = {}): Promise<Map<string, string>> {
  const outputs = new Map<string, string>()
  const layout = scenario.trees ?? trees()
  await execute('Validate the decision against the live head', {
    context,
    process: { env: { LABEL: scenario.label ?? 'accept-screenshots', PR_NUMBER: '123' } },
    core: {
      notice: () => {},
      setOutput: (key: string, value: string) => outputs.set(key, value),
    },
    github: {
      rest: {
        pulls: {
          get: async () => ({
            data: {
              state: scenario.pr?.state ?? 'open',
              head: {
                ref: 'claude/feature',
                sha: scenario.pr?.sha ?? HEAD,
                repo: { full_name: scenario.pr?.repo ?? 'copse-dev/agent-pane' },
              },
            },
          }),
        },
        repos: {
          listCommitStatusesForRef: async () => ({
            data: scenario.statuses ?? [
              { context: 'Screenshot review', state: 'pending', description: '2 changed…' },
            ],
          }),
        },
        git: {
          getRef: async ({ ref }: { ref: string }) => {
            assert.equal(ref, `heads/${BRANCH}`)
            if (scenario.compareRef === null)
              throw Object.assign(new Error('Not Found'), { status: 404 })
            return { data: { object: { sha: scenario.compareRef ?? COMPARE } } }
          },
          getCommit: async ({ commit_sha }: { commit_sha: string }) => {
            if (commit_sha === HEAD) return { data: { tree: { sha: 'head-root' }, parents: [] } }
            assert.equal(commit_sha, scenario.compareRef ?? COMPARE)
            return {
              data: {
                tree: { sha: 'compare-root' },
                parents: (scenario.parents ?? [HEAD]).map((sha) => ({ sha })),
              },
            }
          },
          getTree: async ({ tree_sha }: { tree_sha: string }) => {
            const entries = layout.get(tree_sha)
            assert.ok(entries, tree_sha)
            return { data: { truncated: false, tree: entries } }
          },
        },
      },
    },
  })
  return outputs
}

describe('screenshot review label validation', () => {
  it('accepts a single compare commit on the live head that only adds or updates PNGs', async () => {
    const outputs = await validate()
    assert.equal(outputs.get('outcome'), 'accept')
    assert.equal(outputs.get('compare-commit'), COMPARE)
    assert.equal(outputs.get('head-ref'), 'claude/feature')
    assert.equal(outputs.get('head-sha'), HEAD)
    assert.equal(outputs.get('changed'), '2')
  })

  it('refuses a compare commit that touches anything but flat PNGs in the screenshot tree', async () => {
    for (const [layout, pattern] of [
      [
        trees({
          root: [blob('package.json', 'p2'), tree('src', 's1'), tree('tests', 'compare-tests')],
        }),
        /`package\.json`/,
      ],
      [
        trees({ e2e: [blob('pane.e2e.ts', 'e2'), tree('screenshots', 'compare-shots')] }),
        /`tests\/e2e\/pane\.e2e\.ts`/,
      ],
      [trees({ shots: [blob('a.png', 'a1')] }), /`tests\/e2e\/screenshots\/b\.png`/],
      [trees({ shots: [blob('a.png', 'a1'), blob('b.png', 'b1'), blob('x.txt', 'x1')] }), /x\.txt/],
      [
        trees({ shots: [blob('a.png', 'a1'), blob('b.png', 'b1'), tree('nested.png', 'n1')] }),
        /nested\.png/,
      ],
      [
        trees({
          shots: [
            blob('a.png', 'a1'),
            blob('b.png', 'b1'),
            { ...blob('run.png', 'r1'), mode: '100755' },
          ],
        }),
        /run\.png/,
      ],
      [trees({ shots: [blob('a.png', 'a1'), blob('b.png', 'b1')] }), /changes no screenshot/],
    ] as const) {
      const outputs = await validate({ trees: layout })
      assert.equal(outputs.get('outcome'), 'refuse')
      assert.match(outputs.get('reason') ?? '', pattern)
      assert.equal(outputs.has('compare-commit'), false)
    }
  })

  it('refuses a compare commit that is not exactly one commit on the live head', async () => {
    for (const parents of [['0'.repeat(40)], [HEAD, COMPARE], []]) {
      const outputs = await validate({ parents })
      assert.equal(outputs.get('outcome'), 'refuse', JSON.stringify(parents))
      assert.match(outputs.get('reason') ?? '', /not a single commit on `abc123abc123`/)
    }
  })

  it('refuses accept when the live head has no compare branch', async () => {
    const outputs = await validate({ compareRef: null })
    assert.equal(outputs.get('outcome'), 'refuse')
    assert.match(outputs.get('reason') ?? '', /no compare commit to accept/)
  })

  it('declines a head whose review is pending or failed to publish', async () => {
    for (const state of ['pending', 'error']) {
      const outputs = await validate({
        label: 'decline-screenshots',
        statuses: [{ context: 'Screenshot review', state, description: '…' }],
      })
      assert.equal(outputs.get('outcome'), 'decline')
      assert.equal(outputs.get('head-sha'), HEAD)
    }
  })

  it('refuses a decision before evidence exists or after the review passed', async () => {
    for (const label of ['accept-screenshots', 'decline-screenshots']) {
      const outputs = await validate({
        label,
        statuses: [{ context: 'CI Passed', state: 'success', description: '' }],
      })
      assert.equal(outputs.get('outcome'), 'refuse')
      assert.match(outputs.get('reason') ?? '', /no screenshot evidence has been published/)
    }
    const passed = await validate({
      label: 'decline-screenshots',
      statuses: [
        {
          context: 'Screenshot review',
          state: 'success',
          description: 'No changed reference screenshots',
        },
      ],
    })
    assert.equal(passed.get('outcome'), 'refuse')
    assert.match(passed.get('reason') ?? '', /already passed: No changed reference screenshots/)
  })

  it('refuses closed, fork, and malformed heads', async () => {
    for (const pr of [{ state: 'closed' }, { repo: 'fork/agent-pane' }, { sha: 'abc123' }]) {
      const outputs = await validate({ pr })
      assert.equal(outputs.get('outcome'), 'refuse', JSON.stringify(pr))
      assert.equal(outputs.has('head-sha'), false)
    }
  })
})

const EVIDENCE =
  '<!-- copse-e2e-screenshot-review -->\n### Screenshot evidence\n\n' +
  '<!-- copse-screenshot-review-state -->\n**Review required.** …\n<!-- /copse-screenshot-review-state -->\n\n' +
  'View the compare…'

interface Recorded {
  statuses: { sha: string; state: string; context: string; description: string }[]
  removed: string[]
  created: string[]
  updated: string[]
}

async function record(
  env: Record<string, string>,
  comments = [{ id: 7, user: { type: 'Bot' }, body: EVIDENCE }],
): Promise<Recorded> {
  const result: Recorded = { statuses: [], removed: [], created: [], updated: [] }
  const listComments = (): void => {}
  await execute('Record the decision', {
    context,
    core: { notice: () => {}, info: () => {} },
    process: {
      env: {
        LABEL: 'decline-screenshots',
        PR_NUMBER: '123',
        ACTOR: 'reviewer',
        HEAD_SHA: HEAD,
        RUN_URL: 'https://github.com/copse-dev/agent-pane/actions/runs/5',
        ...env,
      },
    },
    github: {
      rest: {
        repos: {
          createCommitStatus: async (status: Recorded['statuses'][number]) => {
            result.statuses.push(status)
          },
        },
        issues: {
          listComments,
          removeLabel: async ({ name }: { name: string }) => {
            result.removed.push(name)
          },
          createComment: async ({ body }: { body: string }) => {
            result.created.push(body)
          },
          updateComment: async ({ comment_id, body }: { comment_id: number; body: string }) => {
            assert.equal(comment_id, 7)
            result.updated.push(body)
          },
        },
      },
      paginate: async (method: unknown) => {
        assert.equal(method, listComments)
        return comments
      },
    },
  })
  return result
}

describe('recording a screenshot review decision', () => {
  it('passes a declined head and replaces the comment’s review request', async () => {
    const result = await record({ OUTCOME: 'decline' })
    assert.deepEqual(
      result.statuses.map(({ sha, state, context, description }) => [
        sha,
        state,
        context,
        description,
      ]),
      [[HEAD, 'success', 'Screenshot review', 'Declined by @reviewer; no candidate committed']],
    )
    assert.deepEqual(result.removed, ['decline-screenshots'])
    assert.deepEqual(result.created, [])
    const body = result.updated[0] ?? ''
    assert.doesNotMatch(body, /Review required/)
    assert.match(
      body,
      /\*\*Reviewed:\*\* Declined by @reviewer; no candidate committed for `abc123abc123`/,
    )
    assert.ok(body.endsWith('View the compare…'), body)
    assert.equal(body.match(/copse-screenshot-review-state/g)?.length, 2)
  })

  it('records an accepted fast-forward on the reviewed head', async () => {
    const result = await record({
      LABEL: 'accept-screenshots',
      OUTCOME: 'accept',
      PUSHED: 'true',
      COMPARE_COMMIT: COMPARE,
      CHANGED: '2',
      TOKEN_MINTED: 'true',
    })
    assert.deepEqual(
      result.statuses.map(({ sha, description }) => [sha, description]),
      [[HEAD, 'Accepted by @reviewer; committed as def456def456']],
    )
    assert.deepEqual(result.removed, ['accept-screenshots'])
    assert.match(
      result.updated[0] ?? '',
      /fast-forwarded from `abc123abc123` to `def456def456`, committing 2 screenshots/,
    )
  })

  it('appends the decision when the evidence comment has no review block', async () => {
    const result = await record({ OUTCOME: 'decline' }, [
      { id: 7, user: { type: 'Bot' }, body: '<!-- copse-e2e-screenshot-review -->\nold' },
    ])
    assert.match(
      result.updated[0] ?? '',
      /^<!-- copse-e2e-screenshot-review -->\nold\n\n<!-- copse-screenshot-review-state -->\n\*\*Reviewed:\*\*/,
    )
  })

  it('refuses without touching the gate, and always removes the label', async () => {
    for (const [env, pattern] of [
      [
        { OUTCOME: 'refuse', REASON: 'no compare commit to accept.' },
        /no compare commit to accept\./,
      ],
      [{ OUTCOME: '' }, /could not be evaluated/],
      [{ OUTCOME: 'accept', TOKEN_MINTED: 'false' }, /release App token is unavailable/],
      [{ OUTCOME: 'accept', TOKEN_MINTED: 'true', PUSHED: '' }, /could not be fast-forwarded/],
    ] as const) {
      const result = await record({ LABEL: 'accept-screenshots', ...env })
      assert.deepEqual(result.statuses, [], JSON.stringify(env))
      assert.deepEqual(result.removed, ['accept-screenshots'])
      assert.deepEqual(result.updated, [])
      assert.equal(result.created.length, 1)
      assert.match(result.created[0] ?? '', /^`accept-screenshots` was not applied: /)
      assert.match(result.created[0] ?? '', pattern)
      assert.match(
        result.created[0] ?? '',
        /\(\[workflow run\]\(https:\/\/github\.com\/copse-dev\/agent-pane\/actions\/runs\/5\)\)$/,
      )
    }
  })
})

describe('screenshot-review-labels.yml invariants', () => {
  it('runs only for the two review labels on same-repository PRs, without checking anything out', () => {
    assert.deepEqual(workflow.on.pull_request.types, ['labeled'])
    assert.doesNotMatch(source, /^ +pull_request_target:|uses: actions\/checkout/m)
    assert.match(workflow.jobs.decide.if, /github\.event\.label\.name == 'accept-screenshots'/)
    assert.match(workflow.jobs.decide.if, /github\.event\.label\.name == 'decline-screenshots'/)
    assert.match(
      workflow.jobs.decide.if,
      /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
    )
    assert.deepEqual(workflow.permissions, { contents: 'read' })
    assert.deepEqual(workflow.jobs.decide.permissions, {
      contents: 'read',
      'pull-requests': 'write',
      statuses: 'write',
    })
  })

  it('hands the App token to one unforced fast-forward after validation, and nowhere else', () => {
    const tokenUsers = steps.filter((step) =>
      JSON.stringify(step).includes('app-token.outputs.token'),
    )
    assert.deepEqual(
      tokenUsers.map((step) => step.id ?? step.name),
      ['fast-forward', 'Record the decision'],
    )
    const record = steps.find((step) => step.name === 'Record the decision')
    assert.equal(record?.env?.['TOKEN_MINTED'], "${{ steps.app-token.outputs.token != '' }}")
    assert.equal(record.with?.['github-token'], undefined)
    assert.equal(record.if, 'always()')

    const mint = steps.find((step) => step.id === 'app-token')
    assert.equal(mint?.uses, 'actions/create-github-app-token@v3')
    assert.equal(mint.if, "steps.validate.outputs.outcome == 'accept'")
    assert.equal(mint['continue-on-error'], true)
    assert.equal(mint.with?.['permission-contents'], 'write')

    const fastForward = steps.find((step) => step.id === 'fast-forward')
    assert.equal(
      fastForward?.if,
      "steps.validate.outputs.outcome == 'accept' && steps.app-token.outputs.token != ''",
    )
    assert.equal(fastForward['continue-on-error'], true)
    assert.equal(fastForward.with?.['github-token'], '${{ steps.app-token.outputs.token }}')
    const script = z.string().parse(fastForward.with['script'])
    assert.match(script, /git\.updateRef\(/)
    assert.match(script, /force: false/)
    assert.deepEqual(
      steps.map((step) => step.id ?? step.name),
      ['validate', 'app-token', 'fast-forward', 'Record the decision'],
    )
  })
})
