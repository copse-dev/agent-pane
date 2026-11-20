import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import { z } from 'zod'
import { parseScreenshotStack, verifyScreenshotStack } from './screenshot-stack.mts'

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
        steps: z.array(
          z.object({
            name: z.string(),
            uses: z.string(),
            if: z.string().optional(),
            env: z.record(z.string(), z.string()).optional(),
            with: z.record(z.string(), z.unknown()),
          }),
        ),
      }),
    }),
  })
  .parse(load(source))
const step = z
  .object({
    uses: z.string(),
    env: z.record(z.string(), z.string()),
    with: z.object({ script: z.string() }),
  })
  .parse(
    workflow.jobs.retire.steps.find(
      (candidate) => candidate.name === "Retire the previous head's screenshot evidence",
    ),
  )
const policy =
  workflow.jobs.retire.steps.find(
    (candidate) => candidate.name === 'Load trusted screenshot stack policy',
  ) ?? assert.fail('missing trusted policy')

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
  action?: 'synchronize' | 'ready_for_review'
  sha?: string
  pr?: {
    state?: string
    sha?: string
    repo?: string
    body?: string
    labels?: string[]
    draft?: boolean
  }
  comments?: Comment[]
  removeLabel?: Error
  run?: Partial<SourceRun>
  runError?: Error
  statusError?: Error
  jobs?: SourceJob[]
  jobError?: Error
  artifacts?: { name: string; expired: boolean }[]
  sourceTip?: { sha: string; body: string; statuses: NonNullable<Scenario['statuses']> }
  afterArtifactTipBody?: string
  lowerSha?: string
  diverged?: boolean
  statuses?: {
    context: string
    id?: number
    state: string
    description: string
    creator?: { login: string; id?: number }
    target_url?: string
  }[]
}

interface SourceRun {
  id: number
  name: string
  path: string
  event: string
  status: string
  conclusion: string | null
  head_sha: string
  repository: { full_name: string }
  head_repository: { full_name: string }
  pull_requests: { number: number; head: { sha: string } }[]
}

interface SourceJob {
  name: string
  conclusion: string
  steps: { name: string; conclusion: string }[]
}

function readyEvidence(scope = 'render', total = 1, candidates = false): SourceJob[] {
  const skip = scope === 'no-eligible'
  return [
    {
      name: 'precheck',
      conclusion: 'success',
      steps: [
        {
          name: `Screenshot evidence plan: ${scope} / ${skip ? 'skip / 0' : `${total === 9 ? 'full' : 'subset'} / ${String(total)}`} shards`,
          conclusion: 'success',
        },
      ],
    },
    ...(skip
      ? []
      : [
          {
            name: 'build',
            conclusion: 'success',
            steps: [
              'Build browser reference app',
              'Render browser reference screenshots',
              'Render isolated browser motion screenshots',
              'Collect changed browser reference screenshots',
              'Upload rendered browser screenshots',
            ].map((name) => ({ name, conclusion: 'success' })),
          },
          ...Array.from({ length: total }, (_, index) => ({
            name: `e2e (${String(index + 1)})`,
            conclusion: 'success',
            steps: [
              {
                name: `e2e shard ${String(index + 1)}/${String(total)} (oracle-gated, retry on flaky session startup)`,
                conclusion: 'success',
              },
              { name: 'Collect changed reference screenshots', conclusion: 'success' },
              { name: 'Upload rendered screenshot shard', conclusion: 'success' },
            ],
          })),
          {
            name: 'screenshot-artifacts',
            conclusion: 'success',
            steps: [
              ...[
                'Download rendered screenshot candidates',
                'Verify complete screenshot producer inputs',
                'Drop render noise from the candidate set',
                'Summarize candidate screenshots',
              ].map((name) => ({ name, conclusion: 'success' })),
              {
                name: 'Upload immutable screenshot candidates',
                conclusion: candidates ? 'success' : 'skipped',
              },
            ],
          },
        ]),
  ]
}

function automaticStatus(
  description = 'No changed reference screenshots',
  state = 'success',
): NonNullable<Scenario['statuses']>[number] {
  return {
    context: 'Screenshot review',
    state,
    description,
    creator: { login: 'github-actions[bot]', id: 41898282 },
    target_url: 'https://github.com/copse-dev/agent-pane/actions/runs/99',
  }
}

function stackStatuses(text: string, tipApproved = false): NonNullable<Scenario['statuses']> {
  const declaration = parseScreenshotStack(text) ?? assert.fail('invalid fixture stack')
  return [
    {
      ...automaticStatus(
        tipApproved
          ? 'Accepted by @reviewer; combined stack'
          : 'Combined stack needs explicit screenshot review',
        tipApproved ? 'success' : 'pending',
      ),
      id: 103,
    },
    {
      ...automaticStatus(`Stack coverage ${declaration.digest}`),
      id: 102,
      context: 'Screenshot stack coverage',
    },
    ...(tipApproved
      ? [
          {
            ...automaticStatus(`Stack decision ${declaration.digest}`),
            id: 101,
            context: 'Screenshot stack decision',
          },
        ]
      : []),
  ]
}

interface Effects {
  runReads: number
  jobReads: number
  artifactReads: number
  statuses: { sha: string; state: string; context: string; description: string }[]
  updated: { comment_id: number; body: string }[]
  removedLabels: string[]
  notices: string[]
  failures: string[]
}

const evidence = (body = OLD_EVIDENCE): Comment => ({ id: 7, user: { type: 'Bot' }, body })

async function push(scenario: Scenario = {}): Promise<Effects> {
  const effects: Effects = {
    updated: [],
    removedLabels: [],
    notices: [],
    failures: [],
    statuses: [],
    runReads: 0,
    jobReads: 0,
    artifactReads: 0,
  }
  const listComments = (): void => {}
  const listJobsForWorkflowRun = (): void => {}
  const listWorkflowRunArtifacts = (): void => {}
  let artifactRead = false
  const execution: unknown = runInNewContext(`(async () => {\n${step.with.script}\n})()`, {
    context: { repo: { owner: 'copse-dev', repo: 'agent-pane' } },
    process: {
      env: {
        PR_NUMBER: '123',
        HEAD_SHA: scenario.sha ?? HEAD,
        EVENT_ACTION: scenario.action ?? 'synchronize',
        GITHUB_WORKSPACE: '/trusted-workspace',
      },
    },
    core: {
      info: () => {},
      notice: (message: string) => effects.notices.push(message),
      setFailed: (message: string) => effects.failures.push(message),
    },
    require: (path: string) => {
      assert.equal(path, '/trusted-workspace/screenshot-stack-policy/scripts/screenshot-stack.mts')
      return { verifyScreenshotStack }
    },
    github: {
      paginate: async (method: unknown) => {
        if (method === listJobsForWorkflowRun) {
          effects.jobReads += 1
          if (scenario.jobError) throw scenario.jobError
          return (
            scenario.jobs ??
            readyEvidence(
              'render',
              1,
              (scenario.artifacts ?? []).some(
                (artifact) => artifact.name === 'reference-screenshot-candidates-99',
              ),
            )
          )
        }
        if (method === listWorkflowRunArtifacts) {
          artifactRead = true
          effects.artifactReads += 1
          return scenario.artifacts ?? []
        }
        assert.equal(method, listComments)
        return scenario.comments ?? [evidence()]
      },
      rest: {
        actions: {
          listJobsForWorkflowRun,
          listWorkflowRunArtifacts,
          getWorkflowRun: async ({ run_id }: { run_id: number }) => {
            effects.runReads += 1
            assert.equal(run_id, 99)
            if (scenario.runError) throw scenario.runError
            const run: SourceRun = {
              id: 99,
              name: 'CI',
              path: '.github/workflows/ci.yml',
              event: 'pull_request',
              status: 'completed',
              conclusion: 'success',
              head_sha: HEAD,
              repository: { full_name: 'copse-dev/agent-pane' },
              head_repository: { full_name: 'copse-dev/agent-pane' },
              pull_requests: [{ number: 123, head: { sha: HEAD } }],
              ...scenario.run,
            }
            return { data: run }
          },
        },
        repos: {
          listCommitStatusesForRef: async ({ ref }: { ref: string }) => {
            if (scenario.statusError) throw scenario.statusError
            if (scenario.sourceTip && ref === scenario.sourceTip.sha) {
              return { data: scenario.sourceTip.statuses }
            }
            assert.equal(ref, scenario.sha ?? HEAD)
            return { data: scenario.statuses ?? [] }
          },
          compareCommitsWithBasehead: async ({ basehead }: { basehead: string }) => ({
            data: {
              status: scenario.diverged ? 'diverged' : 'ahead',
              merge_base_commit: { sha: basehead.split('...')[0] },
            },
          }),
          createCommitStatus: async (status: Effects['statuses'][number]) => {
            effects.statuses.push(status)
          },
        },
        pulls: {
          get: async ({ pull_number }: { pull_number: number }) => {
            const tip = scenario.sourceTip && pull_number === 124 ? scenario.sourceTip : undefined
            return {
              data: {
                number: pull_number,
                draft: scenario.pr?.draft ?? false,
                state: scenario.pr?.state ?? 'open',
                body: tip
                  ? artifactRead
                    ? (scenario.afterArtifactTipBody ?? tip.body)
                    : tip.body
                  : (scenario.pr?.body ?? null),
                labels: (scenario.pr?.labels ?? ['screenshots-need-review']).map((name) => ({
                  name,
                })),
                head: {
                  sha:
                    tip?.sha ??
                    (pull_number === 122 ? (scenario.lowerSha ?? OLD) : (scenario.pr?.sha ?? HEAD)),
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
  it('resets nominal zero-result success when the collector did not prove every downloaded input', async () => {
    const name = 'Verify complete screenshot producer inputs'
    for (const state of ['missing', 'skipped', 'failure', 'duplicate']) {
      const jobs = readyEvidence().map((job) => {
        if (job.name !== 'screenshot-artifacts') return job
        const steps = job.steps.filter((step) => step.name !== name)
        if (state !== 'missing')
          steps.push({ name, conclusion: state === 'duplicate' ? 'success' : state })
        if (state === 'duplicate') steps.push({ name, conclusion: 'success' })
        return { ...job, steps }
      })
      const effects = await push({
        action: 'ready_for_review',
        statuses: [automaticStatus()],
        jobs,
        artifacts: [
          { name: 'screenshots-shard-1', expired: true },
          { name: 'screenshots-demo', expired: false },
        ],
      })
      assert.equal(effects.statuses[0]?.state, 'pending', state)
    }
  })

  it('keeps completed zero and candidate evidence after the raw producer artifacts expire', async () => {
    for (const candidates of [false, true]) {
      const effects = await push({
        action: 'ready_for_review',
        statuses: [
          automaticStatus(
            candidates
              ? '2 changed screenshots await review: label accept-screenshots or decline-screenshots'
              : 'No changed reference screenshots',
            candidates ? 'pending' : 'success',
          ),
        ],
        jobs: readyEvidence('render', 1, candidates),
        artifacts: [
          { name: 'screenshots-shard-1', expired: true },
          { name: 'screenshots-demo', expired: true },
          ...(candidates ? [{ name: 'reference-screenshot-candidates-99', expired: false }] : []),
        ],
      })
      assert.deepEqual(effects.statuses, [])
    }
  })

  it('requires the collector input checkpoint before preserving stack tip or lower-member evidence', async () => {
    const tip = 'd'.repeat(40)
    for (const lower of [false, true]) {
      const text = lower
        ? `<!-- copse-screenshot-stack: #123@${HEAD} tip=#124 -->`
        : `<!-- copse-screenshot-stack: #122@${OLD} tip=#123 -->`
      const base: Scenario = {
        action: 'ready_for_review',
        pr: { body: text },
        statuses: lower
          ? [automaticStatus(`Stack deferred to approved tip #124 at ${tip.slice(0, 12)}`)]
          : stackStatuses(text),
        ...(lower
          ? {
              sourceTip: { sha: tip, body: text, statuses: stackStatuses(text, true) },
              run: { head_sha: tip, pull_requests: [{ number: 124, head: { sha: tip } }] },
            }
          : {}),
        artifacts: [
          { name: 'screenshot-stack-coverage-99', expired: false },
          { name: 'screenshots-shard-1', expired: true },
        ],
      }
      for (const state of ['success', 'missing', 'skipped', 'failure', 'duplicate']) {
        const name = 'Verify complete screenshot producer inputs'
        const jobs = readyEvidence('render', 9).map((job) => {
          if (job.name !== 'screenshot-artifacts') return job
          const steps = job.steps.filter((step) => step.name !== name)
          if (state !== 'missing')
            steps.push({ name, conclusion: state === 'duplicate' ? 'success' : state })
          if (state === 'duplicate') steps.push({ name, conclusion: 'success' })
          return { ...job, steps }
        })
        const effects = await push({ ...base, jobs })
        assert.equal(
          effects.statuses[0]?.state,
          state === 'success' ? undefined : 'pending',
          `${String(lower)}/${state}`,
        )
      }
    }
  })

  it('does not turn a successful but unlisted immutable candidate upload into zero-candidate preservation', async () => {
    const effects = await push({
      action: 'ready_for_review',
      statuses: [automaticStatus()],
      jobs: readyEvidence('render', 1, true),
      artifacts: [],
    })
    assert.equal(effects.statuses[0]?.state, 'pending')
  })

  it('resets a same-head draft success when the PR becomes ready, even with no evidence comment', async () => {
    const effects = await push({ action: 'ready_for_review', comments: [] })
    assert.equal(effects.statuses.length, 1)
    const status = effects.statuses[0]
    assert.ok(status)
    assert.equal(status.sha, HEAD)
    assert.equal(status.context, 'Screenshot review')
    assert.equal(status.state, 'pending')
  })

  it('does not preserve a same-head no-screenshot notice across the ready transition', async () => {
    const effects = await push({
      action: 'ready_for_review',
      comments: [evidence(`${MARKER}\nNo screenshots for ${HEAD.slice(0, 12)}`)],
    })
    assert.equal(effects.statuses[0]?.state, 'pending')
    assert.equal(effects.updated.length, 1)
    assert.match(effects.updated[0]?.body ?? '', /Waiting for CI/)
  })

  it('preserves proven complete zero-candidate evidence and explicit decisions if ready runs after publication', async () => {
    for (const description of [
      'No changed reference screenshots',
      'No eligible reference screenshot specs (oracle plan)',
      'Accepted by @reviewer; screenshot-only follow-up of abc123abc123',
      'Declined by @reviewer; no candidate committed',
    ]) {
      const effects = await push({
        action: 'ready_for_review',
        jobs: readyEvidence(description.includes('(oracle plan)') ? 'no-eligible' : 'render'),
        statuses: [
          {
            context: 'Screenshot review',
            state: 'success',
            description,
            creator: { login: 'github-actions[bot]', id: 41898282 },
            target_url: 'https://github.com/copse-dev/agent-pane/actions/runs/99',
          },
        ],
      })
      assert.deepEqual(effects.statuses, [])
      assert.deepEqual(effects.updated, [])
    }
  })

  it('rejects run-shaped automatic success unless the actual completed canonical PR CI belongs to this exact head and repository', async () => {
    for (const run of [
      { id: 100 },
      { head_sha: OLD },
      { path: '.github/workflows/other.yml' },
      { name: 'Other' },
      { event: 'push' },
      { status: 'in_progress' },
      { conclusion: null },
      { repository: { full_name: 'other/repo' } },
      { head_repository: { full_name: 'fork/agent-pane' } },
      { pull_requests: [] },
      { pull_requests: [{ number: 999, head: { sha: HEAD } }] },
      { pull_requests: [{ number: 123, head: { sha: OLD } }] },
      {
        pull_requests: [
          { number: 123, head: { sha: HEAD } },
          { number: 124, head: { sha: HEAD } },
        ],
      },
    ] satisfies Partial<SourceRun>[]) {
      const effects = await push({ action: 'ready_for_review', statuses: [automaticStatus()], run })
      assert.equal(effects.statuses[0]?.state, 'pending', JSON.stringify(run))
      assert.equal(effects.runReads, 1)
    }
  })

  it('resets automatic success on missing, unavailable, incomplete or ambiguous actual evidence', async () => {
    for (const scenario of [
      { statusError: new Error('Statuses unavailable') },
      { runError: new Error('Not Found') },
      { jobError: new Error('Forbidden') },
      { jobs: [] },
      {
        jobs: readyEvidence().map((job) =>
          job.name === 'screenshot-artifacts' ? { ...job, steps: [] } : job,
        ),
      },
      { jobs: [...readyEvidence(), { name: 'precheck', conclusion: 'failure', steps: [] }] },
      { artifacts: [{ name: 'reference-screenshot-candidates-99', expired: true }] },
      { artifacts: [{ name: 'reference-screenshot-candidates-99', expired: false }] },
    ] satisfies Scenario[]) {
      const effects = await push({
        ...scenario,
        action: 'ready_for_review',
        statuses: [automaticStatus()],
      })
      assert.equal(effects.statuses[0]?.state, 'pending')
    }
  })

  it('preserves current candidate evidence and its reminder when its valid publisher finishes before a delayed ready handler', async () => {
    const effects = await push({
      action: 'ready_for_review',
      comments: [evidence(OLD_EVIDENCE.replaceAll(OLD.slice(0, 12), HEAD.slice(0, 12)))],
      statuses: [
        automaticStatus(
          '2 changed screenshots await review: label accept-screenshots or decline-screenshots',
          'pending',
        ),
      ],
      artifacts: [{ name: 'reference-screenshot-candidates-99', expired: false }],
    })
    assert.deepEqual(effects.statuses, [])
    assert.deepEqual(effects.updated, [])
    assert.deepEqual(effects.removedLabels, [])
    assert.equal(effects.runReads, 1)
    assert.equal(effects.jobReads, 1)
    assert.equal(effects.artifactReads, 1)
  })

  it('preserves a validated pending stack tip with zero candidates while retaining its explicit review requirement', async () => {
    const text = `<!-- copse-screenshot-stack: #122@${OLD} tip=#123 -->`
    const effects = await push({
      action: 'ready_for_review',
      pr: { body: text },
      statuses: stackStatuses(text),
      jobs: readyEvidence('render', 9),
      artifacts: [{ name: 'screenshot-stack-coverage-99', expired: false }],
      comments: [evidence(OLD_EVIDENCE.replaceAll(OLD.slice(0, 12), HEAD.slice(0, 12)))],
    })
    assert.deepEqual(effects.statuses, [])
    assert.deepEqual(effects.updated, [])
    assert.deepEqual(effects.removedLabels, [])
    assert.equal(effects.runReads, 1)
  })

  it('preserves a ready lower member only through its pinned head and the approved live tip source run', async () => {
    const tip = 'd'.repeat(40)
    const text = `<!-- copse-screenshot-stack: #123@${HEAD} tip=#124 -->`
    const effects = await push({
      action: 'ready_for_review',
      pr: { body: text },
      statuses: [
        {
          ...automaticStatus(`Stack deferred to approved tip #124 at ${tip.slice(0, 12)}`),
          id: 100,
        },
      ],
      sourceTip: { sha: tip, body: text, statuses: stackStatuses(text, true) },
      run: { head_sha: tip, pull_requests: [{ number: 124, head: { sha: tip } }] },
      jobs: readyEvidence('render', 9),
      artifacts: [{ name: 'screenshot-stack-coverage-99', expired: false }],
    })
    assert.deepEqual(effects.statuses, [])
    assert.deepEqual(effects.updated, [])
    assert.equal(effects.runReads, 1)
  })

  it('does not preserve stack evidence with legacy, changed-pin, incomplete, missing or run-mismatched provenance', async () => {
    const text = `<!-- copse-screenshot-stack: #122@${OLD} tip=#123 -->`
    const base: Scenario = {
      action: 'ready_for_review',
      pr: { body: text },
      statuses: stackStatuses(text),
      jobs: readyEvidence('render', 9),
      artifacts: [{ name: 'screenshot-stack-coverage-99', expired: false }],
    }
    for (const change of [
      {
        statuses: stackStatuses(text).map((status) => ({
          ...status,
          target_url: 'https://github.com/copse-dev/agent-pane/pull/123',
        })),
      },
      {
        statuses: stackStatuses(text).filter(
          (status) => status.context !== 'Screenshot stack coverage',
        ),
      },
      { lowerSha: 'e'.repeat(40) },
      { diverged: true },
      { pr: { body: text.replace(OLD, 'e'.repeat(40)) } },
      { run: { head_sha: OLD } },
      { run: { path: '.github/workflows/other.yml' } },
      { artifacts: [] },
      { artifacts: [{ name: 'screenshot-stack-coverage-99', expired: true }] },
      {
        artifacts: [
          { name: 'screenshot-stack-coverage-99', expired: false },
          { name: 'screenshot-stack-coverage-99', expired: false },
        ],
      },
      { jobs: readyEvidence() },
    ] satisfies Scenario[]) {
      const effects = await push({ ...base, ...change })
      assert.equal(effects.statuses[0]?.state, 'pending')
    }
  })

  it('does not reuse a lower deferral when its source run belongs to the lower head, its pin changes or the tip decision is absent', async () => {
    const tip = 'd'.repeat(40)
    const text = `<!-- copse-screenshot-stack: #123@${HEAD} tip=#124 -->`
    const base: Scenario = {
      action: 'ready_for_review',
      pr: { body: text },
      statuses: [
        {
          ...automaticStatus(`Stack deferred to approved tip #124 at ${tip.slice(0, 12)}`),
          id: 100,
        },
      ],
      sourceTip: { sha: tip, body: text, statuses: stackStatuses(text, true) },
      run: { head_sha: tip, pull_requests: [{ number: 124, head: { sha: tip } }] },
      jobs: readyEvidence('render', 9),
      artifacts: [{ name: 'screenshot-stack-coverage-99', expired: false }],
    }
    for (const change of [
      { run: { head_sha: HEAD, pull_requests: [{ number: 123, head: { sha: HEAD } }] } },
      { pr: { body: text.replace(HEAD, OLD) } },
      { sourceTip: { sha: tip, body: text, statuses: stackStatuses(text, false) } },
      { afterArtifactTipBody: text.replace(HEAD, OLD) },
      {
        sourceTip: {
          sha: tip,
          body: text,
          statuses: stackStatuses(text, true).map((status) =>
            status.context === 'Screenshot stack coverage' ? { ...status, target_url: '' } : status,
          ),
        },
      },
    ] satisfies Scenario[]) {
      const effects = await push({ ...base, ...change })
      assert.equal(effects.statuses[0]?.state, 'pending')
    }
  })

  it('does not preserve legacy, untrusted, wrong-repository or older automatic success across ready', async () => {
    const base = {
      context: 'Screenshot review',
      state: 'success',
      description: 'No changed reference screenshots',
      creator: { login: 'github-actions[bot]', id: 41898282 },
      target_url: 'https://github.com/copse-dev/agent-pane/actions/runs/99',
    }
    for (const statuses of [
      [{ ...base, target_url: 'https://github.com/copse-dev/agent-pane/pull/123' }],
      [{ ...base, creator: { login: 'someone' } }],
      [{ ...base, target_url: 'https://github.com/other/repo/actions/runs/99' }],
      [{ ...base, state: 'pending' }, base],
    ]) {
      const effects = await push({ action: 'ready_for_review', statuses })
      assert.equal(effects.statuses[0]?.state, 'pending')
    }
  })

  it('rechecks actual screenshot upload and demo rendering instead of preserving nominal source-job success', async () => {
    for (const name of [
      'Upload rendered screenshot shard',
      'Render browser reference screenshots',
      'Upload rendered browser screenshots',
    ]) {
      const jobs = readyEvidence().map((job) => ({
        ...job,
        steps: job.steps.map((step) =>
          step.name === name ? { ...step, conclusion: 'skipped' } : step,
        ),
      }))
      const effects = await push({
        action: 'ready_for_review',
        statuses: [automaticStatus()],
        jobs,
      })
      assert.equal(effects.statuses[0]?.state, 'pending', name)
    }
  })

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
    assert.deepEqual(workflow.on.pull_request.types, ['synchronize', 'ready_for_review'])
    assert.doesNotMatch(source, /^ +pull_request_target:|^ +run:/m)
    assert.equal(
      workflow.jobs.retire.if,
      'github.event.pull_request.head.repo.full_name == github.repository',
    )
    assert.deepEqual(workflow.permissions, { contents: 'read' })
    assert.deepEqual(workflow.jobs.retire.permissions, {
      actions: 'read',
      contents: 'read',
      'pull-requests': 'write',
      statuses: 'write',
    })
    assert.equal(step.uses, 'actions/github-script@v9')
    assert.equal(policy.uses, 'actions/checkout@v7.0.1')
    assert.equal(policy.if, "github.event.action == 'ready_for_review'")
    assert.equal(policy.with['ref'], '${{ github.event.pull_request.base.sha }}')
    assert.equal(policy.with['persist-credentials'], false)
    assert.equal(policy.with['path'], 'screenshot-stack-policy')
    assert.deepEqual(z.string().parse(policy.with['sparse-checkout']).trim().split('\n'), [
      'scripts/screenshot-stack.mts',
      'scripts/lib/safe-json.mts',
    ])
    assert.doesNotMatch(
      step.with.script,
      /\$\{\{/,
      'event data reaches the script only through env',
    )
    assert.deepEqual(step.env, {
      PR_NUMBER: '${{ github.event.pull_request.number }}',
      HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
      EVENT_ACTION: '${{ github.event.action }}',
    })
  })

  it('writes no status on synchronize and only a pending reset on ready', async () => {
    assert.deepEqual((await push()).statuses, [])
    const ready = await push({ action: 'ready_for_review' })
    assert.equal(ready.statuses.length, 1)
    assert.equal(ready.statuses[0]?.state, 'pending')
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
