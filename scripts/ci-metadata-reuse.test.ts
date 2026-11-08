import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import { z } from 'zod'
import {
  candidateIdentity,
  findCompletedVerification,
  type ReuseInput,
} from './ci-metadata-reuse.mts'

const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const MERGE = 'c'.repeat(40)
const BLOB = 'd'.repeat(40)
const NOW = Date.parse('2026-11-08T18:00:00Z')
const success = { status: 'completed', conclusion: 'success' }
const passedStep = (name: string): object => ({ name, ...success })
const job = (name: string, steps: object[] = []): Record<string, unknown> => ({
  name,
  steps,
  ...success,
})

function fixture(): {
  input: ReuseInput
  pr: Record<string, unknown>
  run: Record<string, unknown>
  runs: Record<string, unknown>[]
  jobs: Record<string, unknown>[]
  calls: string[]
  request: (route: string, params: Record<string, string | number>) => Promise<{ data: unknown }>
} {
  const repository = { id: 1, full_name: 'copse-dev/agent-pane' }
  const pr: Record<string, unknown> = {
    number: 42,
    state: 'open',
    body: 'Updated validation results',
    draft: false,
    head: { sha: HEAD, repo: repository },
    base: { sha: BASE, ref: 'main', repo: repository },
    merge_commit_sha: MERGE,
    labels: [{ name: 'ci-full' }],
  }
  const input: ReuseInput = {
    eventName: 'pull_request',
    sha: MERGE,
    runId: 20,
    now: NOW,
    runnerImage: 'ubuntu24/20261101.1.0',
    checksRunner: '',
    e2eRunner: '',
    payload: { action: 'edited', repository, pull_request: pr, changes: { body: { from: '' } } },
  }
  const run: Record<string, unknown> = {
    id: 10,
    run_attempt: 1,
    path: '.github/workflows/ci.yml',
    event: 'pull_request',
    head_sha: HEAD,
    repository,
    head_repository: repository,
    pull_requests: [{ number: 42 }],
    run_started_at: new Date(NOW - 60_000).toISOString(),
    updated_at: new Date(NOW - 30_000).toISOString(),
    ...success,
  }
  const runs = [run]
  const jobs = [
    job('precheck', [
      passedStep(candidateIdentity(input)),
      passedStep(`Native runtime v1 / ${input.runnerImage}`),
      passedStep('Screenshot evidence plan: render / full / 9 shards'),
    ]),
    job('check'),
    job('CI Passed'),
    job('screenshot-baselines'),
    job('screenshot-artifacts'),
    job(
      'build',
      [
        'Build browser reference app',
        'Render browser reference screenshots',
        'Render isolated browser motion screenshots',
        'Collect changed browser reference screenshots',
        'Upload rendered browser screenshots',
      ].map(passedStep),
    ),
    ...Array.from({ length: 9 }, (_, i) =>
      job(`e2e (${String(i + 1)})`, [
        passedStep(`Native runtime v1 / ${input.runnerImage}`),
        passedStep(`e2e shard ${String(i + 1)}/9 (oracle-gated, retry on flaky session startup)`),
        passedStep('Collect changed reference screenshots'),
        passedStep('Upload rendered screenshot shard'),
      ]),
    ),
  ]
  const calls: string[] = []
  const request = async (
    route: string,
    params: Record<string, string | number>,
  ): Promise<{ data: unknown }> => {
    calls.push(route)
    assert.equal(params['owner'], 'copse-dev')
    assert.equal(params['repo'], 'agent-pane')
    if (route.endsWith('/pulls/{pull_number}')) return { data: pr }
    if (route.endsWith('/contents/{path}')) return { data: { sha: BLOB } }
    if (route.endsWith('/workflows/{workflow_id}/runs')) {
      assert.equal(params['workflow_id'], 'ci.yml')
      assert.equal(params['head_sha'], HEAD)
      assert.equal(params['event'], 'pull_request')
      assert.equal(params['per_page'], 20)
      assert.equal(params['status'], undefined, 'do not hide newer failed/running verification')
      return { data: { workflow_runs: runs, total_count: runs.length } }
    }
    if (route.endsWith('/attempts/{attempt_number}/jobs')) {
      assert.equal(params['attempt_number'], 1)
      return { data: { jobs, total_count: jobs.length } }
    }
    if (route.endsWith('/actions/runs/{run_id}')) return { data: run }
    throw new Error(`Unexpected route ${route}`)
  }
  return { input, pr, run, runs, jobs, calls, request }
}

describe('completed exact-candidate verification', () => {
  it('reuses only an actual successful full browser/native run, with a live identity recheck', async () => {
    const f = fixture()
    assert.equal(
      await findCompletedVerification(f.request, f.input),
      'https://github.com/copse-dev/agent-pane/actions/runs/10/attempts/1',
    )
    assert.equal(f.calls.filter((route) => route.endsWith('/pulls/{pull_number}')).length, 2)
  })

  it('admits title, body and combined edits, including empty/null previous bodies', async () => {
    for (const changes of [
      { title: { from: 'old' } },
      { body: { from: null } },
      { title: { from: '' }, body: { from: '' } },
    ]) {
      const f = fixture()
      const payload = z.record(z.string(), z.unknown()).parse(f.input.payload)
      f.input.payload = { ...payload, changes }
      assert.ok(await findCompletedVerification(f.request, f.input))
    }
  })

  it('rejects ordinary events, retargets, unknown or malformed changes before any API call', async () => {
    for (const override of [
      { action: 'synchronize' },
      { action: 'labeled' },
      { action: 'ready_for_review' },
      { changes: {} },
      { changes: null },
      { changes: { base: { from: 'release' } } },
      { changes: { title: { from: '' }, base: { from: '' } } },
      { changes: { body: { from: '' }, unknown: { from: '' } } },
      { changes: { body: {} } },
      { changes: { body: { from: 3 } } },
    ]) {
      const f = fixture()
      f.input.payload = { ...z.record(z.string(), z.unknown()).parse(f.input.payload), ...override }
      assert.equal(await findCompletedVerification(f.request, f.input), null)
      assert.equal(f.calls.length, 0)
    }
    for (const eventName of ['merge_group', 'push', 'schedule', 'pull_request_target']) {
      const f = fixture()
      assert.equal(await findCompletedVerification(f.request, { ...f.input, eventName }), null)
      assert.equal(f.calls.length, 0)
    }
  })

  it('keeps fork, promotion and formal stack validation on their real verification path', async () => {
    for (const override of [
      { head: { sha: HEAD, repo: { id: 2 } } },
      { base: { sha: BASE, ref: 'release', repo: { id: 1 } } },
      { body: '<!-- copse-screenshot-stack: malformed too -->' },
    ]) {
      const f = fixture()
      Object.assign(f.pr, override)
      assert.equal(await findCompletedVerification(f.request, f.input), null)
      assert.equal(f.calls.length, 0)
    }
    const f = fixture()
    f.input.payload = {
      ...z.record(z.string(), z.unknown()).parse(f.input.payload),
      changes: { body: { from: '<!-- copse-screenshot-stack: removed -->' } },
    }
    assert.equal(await findCompletedVerification(f.request, f.input), null)
  })

  it('rejects changed source, base, merge, draft, labels and runtime policy identities', async () => {
    const variants = [
      { head: { sha: 'e'.repeat(40), repo: { id: 1 } } },
      { base: { sha: 'e'.repeat(40), ref: 'main', repo: { id: 1 } } },
      { merge_commit_sha: 'e'.repeat(40) },
      { draft: true },
      { labels: [{ name: 'update-screenshots' }] },
    ]
    for (const override of variants) {
      const f = fixture()
      Object.assign(f.pr, override)
      assert.equal(await findCompletedVerification(f.request, f.input), null)
    }
    for (const override of [
      { sha: 'e'.repeat(40) },
      { checksRunner: 'copse-checks' },
      { e2eRunner: 'copse-e2e' },
      { runnerImage: 'ubuntu24/20261102.1.0' },
      { runnerImage: '' },
    ]) {
      const f = fixture()
      assert.equal(await findCompletedVerification(f.request, { ...f.input, ...override }), null)
    }
  })

  it('rejects stale, foreign, wrong-workflow, failed, cancelled or running receipts', async () => {
    for (const override of [
      { run_started_at: new Date(NOW - 86_400_001).toISOString() },
      { run_started_at: 'unknown' },
      { event: 'workflow_dispatch' },
      { path: '.github/workflows/impostor.yml' },
      { head_sha: 'e'.repeat(40) },
      { repository: { id: 2 } },
      { head_repository: { id: 2 } },
      { pull_requests: [{ number: 43 }] },
      { run_attempt: 0 },
      { conclusion: 'failure' },
      { conclusion: 'cancelled' },
      { status: 'in_progress' },
    ]) {
      const f = fixture()
      Object.assign(f.run, override)
      assert.equal(await findCompletedVerification(f.request, f.input), null)
    }
  })

  it('never uses an older green after newer failed, cancelled or running work', async () => {
    for (const conclusion of ['failure', 'cancelled', null]) {
      const f = fixture()
      f.runs.unshift({
        ...f.run,
        id: 19,
        conclusion,
        updated_at: new Date(NOW - 1_000).toISOString(),
      })
      assert.equal(await findCompletedVerification(f.request, f.input), null)
    }
  })

  it('rejects a newer failed/running attempt of an older run ID and a run started during verification', async () => {
    for (const conclusion of ['failure', 'cancelled', null]) {
      const f = fixture()
      f.runs.push({
        ...f.run,
        id: 5,
        run_attempt: 2,
        conclusion,
        updated_at: new Date(NOW - 1_000).toISOString(),
      })
      assert.equal(await findCompletedVerification(f.request, f.input), null)
    }
    const f = fixture()
    let reads = 0
    const request: typeof f.request = async (route, params) => {
      if (route.endsWith('/workflows/{workflow_id}/runs') && ++reads === 2)
        f.runs.unshift({
          ...f.run,
          id: 19,
          status: 'in_progress',
          updated_at: new Date(NOW).toISOString(),
        })
      return f.request(route, params)
    }
    assert.equal(await findCompletedVerification(request, f.input), null)
  })

  it('rejects ambiguous attempt timestamps and a single native shard on a different image', async () => {
    const tied = fixture()
    tied.runs.push({ ...tied.run, id: 5, run_attempt: 2, conclusion: 'failure' })
    assert.equal(await findCompletedVerification(tied.request, tied.input), null)
    const drifted = fixture()
    const shard = drifted.jobs.find((j) => j['name'] === 'e2e (3)')
    assert.ok(shard)
    shard['steps'] = z
      .array(z.object({ name: z.string() }).loose())
      .parse(shard['steps'])
      .map((entry) =>
        entry.name.startsWith('Native runtime v1')
          ? { ...entry, name: 'Native runtime v1 / ubuntu24/20261102.1.0' }
          : entry,
      )
    assert.equal(await findCompletedVerification(drifted.request, drifted.input), null)
  })

  it('requires all actual workload steps and refuses missing, duplicate or skipped records', async () => {
    for (const name of [
      'precheck',
      'check',
      'CI Passed',
      'build',
      'screenshot-baselines',
      'screenshot-artifacts',
      'e2e (9)',
    ]) {
      for (const alteration of ['remove', 'duplicate', 'skip', 'steps']) {
        const f = fixture()
        const target = f.jobs.find((j) => j['name'] === name)
        assert.ok(target)
        if (alteration === 'remove') f.jobs.splice(f.jobs.indexOf(target), 1)
        if (alteration === 'duplicate') f.jobs.push({ ...target })
        if (alteration === 'skip') target['conclusion'] = 'skipped'
        if (alteration === 'steps') {
          if (!['precheck', 'e2e (9)'].includes(name)) continue
          target['steps'] = []
        }
        assert.equal(
          await findCompletedVerification(f.request, f.input),
          null,
          `${name}: ${alteration}`,
        )
      }
    }
  })

  it('rejects changed trusted policy, truncated pages, API failures and racing reruns/head changes', async () => {
    for (const fault of ['policy', 'pagination', 'history', 'exception', 'attempt', 'head']) {
      const f = fixture()
      let pulls = 0
      const request: typeof f.request = async (route, params) => {
        if (fault === 'exception') throw new Error('API quota exhausted')
        if (fault === 'policy' && params['ref'] === MERGE) return { data: { sha: 'e'.repeat(40) } }
        if (fault === 'history' && route.endsWith('/workflows/{workflow_id}/runs'))
          return { data: { workflow_runs: f.runs, total_count: 21 } }
        if (fault === 'pagination' && route.endsWith('/jobs'))
          return { data: { jobs: f.jobs, total_count: 101 } }
        if (fault === 'attempt' && route.endsWith('/actions/runs/{run_id}'))
          return { data: { ...f.run, run_attempt: 2 } }
        if (route.endsWith('/pulls/{pull_number}') && ++pulls === 2 && fault === 'head')
          return { data: { ...f.pr, head: { sha: 'e'.repeat(40) } } }
        return f.request(route, params)
      }
      assert.equal(await findCompletedVerification(request, f.input), null, fault)
    }
  })

  it('does not turn reuse-only runs into original verification', async () => {
    const f = fixture()
    const precheck = f.jobs.find((job) => job['name'] === 'precheck')
    assert.ok(precheck)
    const steps = z.array(z.unknown()).parse(precheck['steps'])
    steps.push(passedStep('Reusing verified native suites'))
    precheck['steps'] = steps
    assert.equal(await findCompletedVerification(f.request, f.input), null)
  })
})

describe('trusted workflow wiring', () => {
  const workflow = z
    .object({
      jobs: z.record(
        z.string(),
        z.object({
          needs: z.union([z.string(), z.array(z.string())]).optional(),
          permissions: z.record(z.string(), z.string()).optional(),
          steps: z
            .array(
              z.object({
                name: z.string().optional(),
                run: z.string().optional(),
                with: z.object({ script: z.string().optional() }).loose().optional(),
              }),
            )
            .optional(),
        }),
      ),
    })
    .parse(load(readFileSync('.github/workflows/ci.yml', 'utf8')))

  it('loads pinned base policy without candidate imports or a write token', () => {
    const reuse = workflow.jobs['verification-reuse']
    assert.ok(reuse)
    assert.deepEqual(reuse.permissions, {
      contents: 'read',
      actions: 'read',
      'pull-requests': 'read',
    })
    const script = reuse.steps?.[0]?.with?.script ?? ''
    assert.match(script, /ref: context.payload.pull_request.base.sha/)
    assert.match(script, /stripTypeScriptTypes/)
    assert.doesNotMatch(script, /pull_request.head.sha|exec|checkout|createCommitStatus/)
    assert.equal(workflow.jobs['precheck']?.needs, 'verification-reuse')
  })

  it('records identity from immutable event fields and verifies the actual checkout', () => {
    const marker = workflow.jobs['precheck']?.steps?.find((s) =>
      s.name?.startsWith('Candidate verification v1'),
    )
    assert.ok(marker)
    assert.match(marker.run ?? '', /git rev-parse HEAD/)
    assert.ok(marker.name?.includes('${{ github.sha }}'))
    assert.ok(marker.name?.includes('${{ github.event.pull_request.base.sha }}'))
    assert.ok(marker.name?.includes('${{ github.event.pull_request.head.sha }}'))
    assert.doesNotMatch(marker.name ?? '', /steps\.|needs\./)
  })

  it('matches the complete immutable identity expression, including every label and runner field', () => {
    const marker = workflow.jobs['precheck']?.steps?.find((s) =>
      s.name?.startsWith('Candidate verification v1'),
    )?.name
    assert.ok(marker)
    const f = fixture()
    for (const labels of [
      [],
      [{ name: 'ci-full' }],
      [{ name: 'update-screenshots' }, { name: 'bench-agent' }],
    ]) {
      f.pr['labels'] = labels
      for (const draft of [false, true]) {
        f.pr['draft'] = draft
        const actual: string = marker.replace(
          /\$\{\{ ([\s\S]*?) \}\}/g,
          (_token: string, expression: string) => {
            const value: unknown = runInNewContext(
              expression.replaceAll('.labels.*.name', '.labels.map(x => x.name)'),
              {
                github: { sha: f.input.sha, base_ref: 'main', event: { pull_request: f.pr } },
                vars: {
                  SELF_HOSTED_CHECKS: f.input.checksRunner,
                  SELF_HOSTED_E2E: f.input.e2eRunner,
                },
                contains: (values: unknown[], value: unknown) => values.includes(value),
              },
            )
            assert.ok(typeof value === 'string' || typeof value === 'boolean')
            return String(value)
          },
        )
        assert.equal(actual, candidateIdentity(f.input))
      }
    }
  })

  it('captures native image before candidate code and falls back when this run observes image drift', () => {
    const yaml = readFileSync('.github/workflows/ci.yml', 'utf8')
    for (const name of ['precheck', 'e2e']) {
      const start = yaml.indexOf(`  ${name}:`)
      const capture = yaml.indexOf('- name: Capture native runner image', start)
      const marker = yaml.indexOf('- name: Native runtime v1', capture)
      const checkout = yaml.indexOf('- uses: actions/checkout', start)
      assert.ok(start < capture && capture < marker && marker < checkout)
    }
    assert.ok(
      yaml.includes(
        "verified_source: ${{ steps.native-runtime.outputs.image == needs.verification-reuse.outputs.image && needs.verification-reuse.outputs.source || '' }}",
      ),
    )
  })

  it('keeps screenshot publication with the original run, including queued/failed publication', () => {
    const publisher = readFileSync('.github/workflows/publish-screenshot-candidates.yml', 'utf8')
    const guard = publisher.indexOf("job.name === 'precheck'")
    assert.ok(guard > 0)
    assert.ok(publisher.indexOf("core.setOutput('not-rendered', 'e2e')") > guard)
    const block = publisher.slice(guard, publisher.indexOf('const successfulStep', guard))
    assert.match(block, /Reusing verified native suites/)
    assert.match(block, /return;/)
    assert.doesNotMatch(block, /setOutput|createCommitStatus|createComment|updateComment/)
  })
})
