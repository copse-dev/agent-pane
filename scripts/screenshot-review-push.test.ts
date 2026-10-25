import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import { z } from 'zod'

// Exercise the script Actions actually executes against a stubbed REST API.
const source = readFileSync('.github/workflows/screenshot-review-push.yml', 'utf8')
const workflow = z
  .object({
    on: z.object({ pull_request: z.object({ types: z.array(z.string()) }) }),
    permissions: z.record(z.string(), z.string()),
    concurrency: z.object({
      group: z.string(),
      queue: z.string(),
      'cancel-in-progress': z.boolean(),
    }),
    jobs: z.object({
      retire: z.object({
        if: z.string(),
        permissions: z.record(z.string(), z.string()),
        // One step: the API calls below are the whole job.
        steps: z.tuple([
          z.object({
            name: z.string(),
            uses: z.string(),
            env: z.record(z.string(), z.string()),
            with: z.object({ script: z.string() }),
          }),
        ]),
      }),
    }),
  })
  .parse(load(source))
const [step] = workflow.jobs.retire.steps

const HEAD = 'abc123abc123abc123abc123abc123abc123abc1'
const OLD = 'fed987fed987fed987fed987fed987fed987fed9'
const MARKER = '<!-- copse-e2e-screenshot-review -->'
const OLD_EVIDENCE = [
  MARKER,
  '### Screenshot evidence',
  '',
  '<!-- copse-screenshot-review-state -->',
  '**Review required.** `screenshots-need-review` is set.',
  `<!-- copse-screenshot-selection:${OLD.slice(0, 12)} -->`,
  '- [ ] `pane.png`',
  '- [ ] **Commit the ticked screenshots**',
  '<!-- /copse-screenshot-review-state -->',
  '',
  `**[View the changed reference screenshots](https://github.com/copse-dev/agent-pane/compare/${OLD}...screenshot-compare/pr-123/${OLD.slice(0, 12)})**`,
  '```sh',
  `git fetch origin screenshot-compare/pr-123/${OLD.slice(0, 12)} && git cherry-pick 0123456789abcdef0123456789abcdef01234567`,
  '```',
].join('\n')

interface Comment {
  id: number
  user: { type: string }
  body: string
}

interface Scenario {
  sha?: string
  pr?: { state?: string; sha?: string; repo?: string; body?: string; labels?: string[] }
  comments?: Comment[]
  removeLabel?: Error
}

interface Effects {
  updated: { comment_id: number; body: string }[]
  removedLabels: string[]
  notices: string[]
  failures: string[]
}

const evidence = (body = OLD_EVIDENCE): Comment => ({ id: 7, user: { type: 'Bot' }, body })

async function push(scenario: Scenario = {}): Promise<Effects> {
  const effects: Effects = { updated: [], removedLabels: [], notices: [], failures: [] }
  const listComments = (): void => {}
  const execution: unknown = runInNewContext(`(async () => {\n${step.with.script}\n})()`, {
    context: { repo: { owner: 'copse-dev', repo: 'agent-pane' } },
    process: { env: { PR_NUMBER: '123', HEAD_SHA: scenario.sha ?? HEAD } },
    core: {
      info: () => {},
      notice: (message: string) => effects.notices.push(message),
      setFailed: (message: string) => effects.failures.push(message),
    },
    github: {
      paginate: async (method: unknown) => {
        assert.equal(method, listComments)
        return scenario.comments ?? [evidence()]
      },
      // No `repos`: retiring evidence must never write a commit status.
      rest: {
        pulls: {
          get: async ({ pull_number }: { pull_number: number }) => {
            assert.equal(pull_number, 123)
            return {
              data: {
                state: scenario.pr?.state ?? 'open',
                body: scenario.pr?.body ?? null,
                labels: (scenario.pr?.labels ?? ['screenshots-need-review']).map((name) => ({
                  name,
                })),
                head: {
                  sha: scenario.pr?.sha ?? HEAD,
                  repo: { full_name: scenario.pr?.repo ?? 'copse-dev/agent-pane' },
                },
              },
            }
          },
        },
        issues: {
          listComments,
          updateComment: async ({ comment_id, body }: { comment_id: number; body: string }) => {
            effects.updated.push({ comment_id, body })
          },
          removeLabel: async ({ name }: { name: string }) => {
            if (scenario.removeLabel) throw scenario.removeLabel
            effects.removedLabels.push(name)
          },
        },
      },
    },
  })
  await execution
  return effects
}

describe('retiring screenshot evidence on push', () => {
  it("replaces the previous head's evidence with a notice naming the pushed head", async () => {
    const effects = await push()
    assert.equal(effects.updated.length, 1)
    const { comment_id, body } = effects.updated[0] ?? assert.fail('comment not updated')
    assert.equal(comment_id, 7)
    assert.ok(body.startsWith(`${MARKER}\n### Screenshot evidence\n`))
    assert.match(
      body,
      /<!-- copse-screenshot-review-state -->\n\*\*Waiting for CI on `abc123abc123`\.\*\*/,
    )
    assert.match(body, /<!-- \/copse-screenshot-review-state -->$/)
    // Nothing from the old head stays actionable: no checkbox, link or command.
    assert.ok(!body.includes(OLD.slice(0, 12)))
    assert.doesNotMatch(body, /- \[ \]|copse-screenshot-selection|cherry-pick|compare\//)
    assert.deepEqual(effects.removedLabels, ['screenshots-need-review'])
  })

  it('retires a recorded decision, which belonged to the previous head', async () => {
    const declined = OLD_EVIDENCE.replace(
      /\*\*Review required\.\*\*[\s\S]*?(?=<!-- \/copse-screenshot-review-state -->)/,
      `**Reviewed:** Declined by @maintainer; no candidate committed for \`${OLD.slice(0, 12)}\`.\n`,
    )
    const effects = await push({ comments: [evidence(declined)], pr: { labels: [] } })
    assert.equal(effects.updated.length, 1)
    assert.doesNotMatch(effects.updated[0]?.body ?? '', /Declined/)
    assert.deepEqual(effects.removedLabels, [], 'no reminder to clear')
  })

  it('leaves evidence that already names the pushed head', async () => {
    // The publisher got there first, or an accept fast-forwarded the branch to
    // this head and recorded that in the comment.
    for (const body of [
      OLD_EVIDENCE.replaceAll(OLD.slice(0, 12), HEAD.slice(0, 12)),
      `${MARKER}\n<!-- copse-screenshot-review-state -->\n**Reviewed:** accepted by @maintainer. ` +
        `The PR branch was fast-forwarded from \`${OLD.slice(0, 12)}\` to \`${HEAD.slice(0, 12)}\`.\n` +
        '<!-- /copse-screenshot-review-state -->',
    ]) {
      const effects = await push({ comments: [evidence(body)] })
      assert.deepEqual(effects.updated, [])
      assert.deepEqual(effects.removedLabels, [])
    }
  })

  it('opens no comment on a PR that never had screenshot evidence', async () => {
    for (const comments of [
      [],
      [{ id: 8, user: { type: 'User' }, body: OLD_EVIDENCE }],
      [{ id: 9, user: { type: 'Bot' }, body: 'Unrelated bot comment' }],
    ]) {
      const effects = await push({ comments })
      assert.deepEqual(effects.updated, [])
      assert.deepEqual(effects.removedLabels, [])
    }
  })

  it('leaves a PR that moved on, closed, or came from a fork to a later event', async () => {
    for (const pr of [{ sha: OLD }, { state: 'closed' }, { repo: 'fork/agent-pane' }]) {
      const effects = await push({ pr })
      assert.deepEqual(effects.updated, [], JSON.stringify(pr))
      assert.deepEqual(effects.removedLabels, [])
      assert.equal(effects.notices.length, 1)
    }
  })

  it('leaves lower stack layers to the stack gate but retires the tip like any PR', async () => {
    const declaration = `<!-- copse-screenshot-stack: #122@${OLD} tip=#124 -->`
    const lower = await push({ pr: { body: declaration } })
    assert.deepEqual(lower.updated, [])
    assert.deepEqual(lower.removedLabels, [])

    const tip = await push({
      pr: { body: `<!-- copse-screenshot-stack: #122@${OLD} tip=#123 -->` },
    })
    assert.equal(tip.updated.length, 1)
  })

  it('refuses a head that is not a full object id before any API call', async () => {
    for (const sha of ['', 'abc123', HEAD.toUpperCase(), `${HEAD.slice(0, 39)}/`]) {
      const effects = await push({ sha })
      assert.equal(effects.failures.length, 1, sha)
      assert.deepEqual(effects.updated, [])
    }
  })

  it('tolerates a reminder another workflow already removed, and surfaces other errors', async () => {
    const gone = await push({ removeLabel: Object.assign(new Error('gone'), { status: 404 }) })
    assert.equal(gone.updated.length, 1)
    await assert.rejects(push({ removeLabel: Object.assign(new Error('boom'), { status: 500 }) }))
  })
})

describe('screenshot-review-push.yml invariants', () => {
  it('runs on same-repository pushes with only the permission it needs, executing no PR code', () => {
    assert.deepEqual(workflow.on.pull_request.types, ['synchronize'])
    assert.doesNotMatch(source, /^ +pull_request_target:|uses: actions\/checkout|^ +run:/m)
    assert.equal(
      workflow.jobs.retire.if,
      'github.event.pull_request.head.repo.full_name == github.repository',
    )
    assert.deepEqual(workflow.permissions, { contents: 'read' })
    assert.deepEqual(workflow.jobs.retire.permissions, { 'pull-requests': 'write' })
    assert.equal(step.uses, 'actions/github-script@v9')
    assert.doesNotMatch(
      step.with.script,
      /\$\{\{/,
      'event data reaches the script only through env',
    )
    assert.deepEqual(step.env, {
      PR_NUMBER: '${{ github.event.pull_request.number }}',
      HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
    })
  })

  it('never writes a commit status, so no decision can land before the new head renders', () => {
    assert.doesNotMatch(step.with.script, /createCommitStatus|statuses/)
  })

  it('queues behind the publisher and decisions for the same PR', () => {
    assert.deepEqual(workflow.concurrency, {
      group: 'screenshot-review-${{ github.event.pull_request.number }}',
      queue: 'max',
      'cancel-in-progress': false,
    })
    const publisher = readFileSync('.github/workflows/publish-screenshot-candidates.yml', 'utf8')
    assert.match(
      publisher,
      /format\('screenshot-review-\{0\}', github\.event\.workflow_run\.pull_requests\[0\]\.number\)/,
    )
    const labels = readFileSync('.github/workflows/screenshot-review-labels.yml', 'utf8')
    assert.match(labels, /group: screenshot-review-\$\{\{ github\.event\.pull_request\.number \}\}/)
  })
})
