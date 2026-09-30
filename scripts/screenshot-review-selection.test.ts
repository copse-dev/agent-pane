import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import { z } from 'zod'

// Exercise the scripts Actions actually executes against a stubbed REST API.
const source = readFileSync('.github/workflows/screenshot-review-selection.yml', 'utf8')
const workflow = z
  .object({
    on: z.object({ issue_comment: z.object({ types: z.array(z.string()) }) }),
    jobs: z.object({
      select: z.object({
        if: z.string(),
        steps: z.array(
          z.object({
            name: z.string().optional(),
            with: z.record(z.string(), z.unknown()).optional(),
          }),
        ),
      }),
    }),
  })
  .parse(load(source))
const steps = workflow.jobs.select.steps

async function execute(name: string, bindings: Record<string, unknown>): Promise<void> {
  const script = z.string().parse(steps.find((step) => step.name === name)?.with?.['script'])
  assert.doesNotMatch(script, /\$\{\{/)
  const execution: unknown = runInNewContext(`(async () => {\n${script}\n})()`, bindings)
  await execution
}

const HEAD = 'abc123abc123abc123abc123abc123abc123abc1'
const COMPARE = 'def456def456def456def456def456def456def4'
const context = { repo: { owner: 'copse-dev', repo: 'agent-pane' } }
const START = '<!-- copse-screenshot-review-state -->'
const END = '<!-- /copse-screenshot-review-state -->'

interface Entry {
  path: string
  mode: string
  type: string
  sha: string
}
const blob = (path: string, sha: string): Entry => ({ path, mode: '100644', type: 'blob', sha })
const tree = (path: string, sha: string): Entry => ({ path, mode: '040000', type: 'tree', sha })
const layout = new Map<string, Entry[]>([
  ['head-root', [tree('tests', 'head-tests')]],
  ['head-tests', [tree('e2e', 'head-e2e')]],
  ['head-e2e', [tree('screenshots', 'head-shots')]],
  ['head-shots', [blob('a.png', 'a1'), blob('b.png', 'b1')]],
  ['compare-root', [tree('tests', 'compare-tests')]],
  ['compare-tests', [tree('e2e', 'compare-e2e')]],
  ['compare-e2e', [tree('screenshots', 'compare-shots')]],
  ['compare-shots', [blob('a.png', 'a2'), blob('b.png', 'b1'), blob('c.png', 'c1')]],
])

function commentBody(
  options: { ticked?: string[]; trigger?: boolean; head?: string } = {},
): string {
  const ticked = options.ticked ?? ['a.png']
  const box = (name: string): string => `- [${ticked.includes(name) ? 'x' : ' '}] \`${name}\``
  return [
    '<!-- copse-e2e-screenshot-review -->',
    START,
    '**Review required.**',
    `<!-- copse-screenshot-selection:${options.head ?? HEAD.slice(0, 12)} -->`,
    ['a.png', 'b.png', 'c.png'].map(box).join('\n'),
    `- [${options.trigger === false ? ' ' : 'x'}] **Commit the ticked screenshots**`,
    END,
  ].join('\n')
}

interface Scenario {
  body?: string
  permission?: string
  author?: string
  statuses?: { context: string; state: string; description: string }[]
  parents?: string[]
  compareRef?: string | null
  prSha?: string
}

async function validate(scenario: Scenario = {}): Promise<Map<string, string>> {
  const outputs = new Map<string, string>()
  await execute('Validate the selection against the live head', {
    context,
    process: { env: { COMMENT_ID: '9', PR_NUMBER: '123', ACTOR: 'maintainer' } },
    core: { notice: () => {}, setOutput: (key: string, value: string) => outputs.set(key, value) },
    github: {
      rest: {
        repos: {
          getCollaboratorPermissionLevel: async () => ({
            data: { permission: scenario.permission ?? 'write' },
          }),
          listCommitStatusesForRef: async () => ({
            data: scenario.statuses ?? [
              { context: 'Screenshot review', state: 'pending', description: '2 changed…' },
            ],
          }),
        },
        issues: {
          getComment: async () => ({
            data: {
              body: scenario.body ?? commentBody(),
              user: { type: scenario.author ?? 'Bot' },
            },
          }),
        },
        pulls: {
          get: async () => ({
            data: {
              state: 'open',
              head: {
                ref: 'claude/feature',
                sha: scenario.prSha ?? HEAD,
                repo: { full_name: 'copse-dev/agent-pane' },
              },
            },
          }),
        },
        git: {
          getRef: async () => {
            if (scenario.compareRef === null)
              throw Object.assign(new Error('Not Found'), { status: 404 })
            return { data: { object: { sha: COMPARE } } }
          },
          getCommit: async ({ commit_sha }: { commit_sha: string }) =>
            commit_sha === HEAD
              ? { data: { tree: { sha: 'head-root' }, parents: [] } }
              : {
                  data: {
                    tree: { sha: 'compare-root' },
                    parents: (scenario.parents ?? [HEAD]).map((sha) => ({ sha })),
                  },
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

describe('screenshot review selection', () => {
  it('starts only from a human edit of the bot evidence comment with the trigger ticked', () => {
    assert.deepEqual(workflow.on.issue_comment.types, ['edited'])
    const condition = workflow.jobs.select.if
    assert.match(condition, /github\.event\.issue\.pull_request/)
    assert.match(condition, /comment\.user\.type == 'Bot'/)
    assert.match(condition, /sender\.type == 'User'/)
    assert.match(condition, /\[x\] \*\*Commit the ticked screenshots\*\*/)
  })

  it('selects only the ticked candidates that the compare commit really changes', async () => {
    const outputs = await validate({ body: commentBody({ ticked: ['a.png', 'c.png'] }) })
    assert.equal(outputs.get('outcome'), 'accept')
    assert.deepEqual(JSON.parse(outputs.get('selected') ?? ''), [
      { name: 'a.png', sha: 'a2' },
      { name: 'c.png', sha: 'c1' },
    ])
    assert.equal(outputs.get('candidates'), '2')
    assert.equal(outputs.get('head-tree'), 'head-root')
    assert.equal(outputs.get('compare-commit'), COMPARE)
  })

  it('refuses every selection it cannot stand behind', async () => {
    const cases: [Scenario, RegExp][] = [
      [{ permission: 'read' }, /write access/],
      [{ author: 'User' }, /no longer asks/],
      [{ body: commentBody({ trigger: false }) }, /no longer ticked/],
      [{ body: commentBody({ ticked: [] }) }, /no screenshot is ticked/],
      [{ body: commentBody({ head: 'fffffffffff0' }) }, /not the current/],
      [
        { statuses: [{ context: 'Screenshot review', state: 'success', description: 'Declined' }] },
        /no longer waiting/,
      ],
      [{ compareRef: null }, /no compare commit/],
      [{ parents: ['0'.repeat(40)] }, /not a single commit/],
      // b.png is identical in both trees, so it is not a candidate.
      [{ body: commentBody({ ticked: ['b.png'] }) }, /not a changed candidate/],
      [
        {
          body: commentBody({ ticked: [] })
            .replace('`c.png`', '`nope.png`')
            .replace('[ ] `nope', '[x] `nope'),
        },
        /not a changed candidate/,
      ],
    ]
    for (const [scenario, pattern] of cases) {
      const outputs = await validate(scenario)
      assert.equal(outputs.get('outcome'), 'refuse')
      assert.match(outputs.get('reason') ?? '', pattern)
      assert.equal(outputs.has('selected'), false)
    }
  })

  it('ignores ticks outside the review block and non-PNG names', async () => {
    const body = `- [x] \`c.png\`\n${commentBody({ ticked: ['a.png'] }).replace('`b.png`', '`../x.txt`')}`
    const outputs = await validate({ body })
    assert.deepEqual(JSON.parse(outputs.get('selected') ?? ''), [{ name: 'a.png', sha: 'a2' }])
  })
})
