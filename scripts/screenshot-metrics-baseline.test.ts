import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregate,
  matchPublisherRun,
  candidatesForPull,
  parseFilterLog,
  parseOraclePlan,
  renderMarkdown,
  representativeRun,
  summarizeJobs,
  type Job,
  type Run,
  type PullBaseline,
  type RunBaseline,
} from './screenshot-metrics-baseline.mts'

const T = (minute: number): string => `2026-10-15T01:${String(minute).padStart(2, '0')}:00Z`

function job(overrides: Partial<Job>): Job {
  return {
    id: 1,
    name: 'precheck',
    conclusion: 'success',
    started_at: T(0),
    completed_at: T(5),
    labels: ['ubuntu-latest'],
    runner_name: 'GitHub Actions 1',
    ...overrides,
  }
}

function run(overrides: Partial<RunBaseline>): RunBaseline {
  return {
    id: 1,
    headSha: 'a'.repeat(40),
    attempt: 1,
    conclusion: 'success',
    createdAt: T(0),
    jobs: {
      runMinutes: 18,
      e2e: {
        shards: 8,
        wallMinutes: 3,
        runnerMinutes: 20,
        labels: ['ubuntu-latest'],
        runnerKind: 'hosted',
      },
      precheckJobId: 1,
      screenshotArtifacts: { jobId: 2, minutes: 3 },
    },
    artifacts: { candidates: { bytes: 100, expired: false }, shardBytes: 10 },
    publisher: { id: 9, conclusion: 'success', minutes: 4 },
    plan: { mode: 'subset', reason: 'oracle', specs: 34 },
    filter: {
      changed: 308,
      kept: 36,
      ignored: 84,
      flapping: 0,
      contested: 0,
      outOfScope: 188,
      scopeAffected: 92,
      branchOwned: 0,
      ignoredZeroPx: 60,
      keptNew: 2,
      unfiltered: false,
    },
    logs: { precheck: 'parsed', filter: 'parsed' },
    ...overrides,
  }
}

function pull(overrides: Partial<PullBaseline>): PullBaseline {
  return {
    number: 3773,
    title: 'Fix codex ready detection',
    author: 'someone',
    createdAt: T(0),
    closedAt: T(30),
    merged: true,
    hoursOpen: 0.5,
    labelsEver: [],
    runs: [run({})],
    compare: { heads: 1, candidates: 36 },
    ...overrides,
  }
}

const FILTER_LOG = [
  '2026-10-15T01:15:16.3937470Z screenshot filter: 308 changed, 36 kept (real), 84 ignored (noise), 0 held (flapping), 0 held (contested), 188 held (out of scope) [color-threshold=0.1, ignore-ratio=0.0008, min-pixels=12, flap-lookback=4, main-ref=origin/main, scope=92 affected + 0 branch-owned]',
  '2026-10-15T01:15:16.3939451Z   keep   tests/e2e/screenshots/settings-acp-agents-list-codex-ready.png (new screenshot (no baseline))',
  '2026-10-15T01:15:16.3940247Z   keep   tests/e2e/screenshots/settings-composition-sticky-footer.png (7166 px, 0.1866%)',
  '2026-10-15T01:15:16.3945355Z   ignore tests/e2e/screenshots/activity-dialog-text-selection.png (0 px, 0.0000%)',
  '2026-10-15T01:15:16.4021548Z   ignore tests/e2e/screenshots/app-run-progress.png (85 px, 0.0331%)',
  '2026-10-15T01:15:16.4120898Z   ignore tests/e2e/screenshots/app-run-setup.png (0 px, 0.0000%)',
  '2026-10-15T01:15:16.4120898Z   scope  tests/e2e/screenshots/other.png (out of scope: no selected spec renders this shot for this diff; 12 px vs HEAD)',
].join('\n')

describe('screenshot-metrics-baseline', () => {
  it('parses the filter summary and counts pixel-identical ignores and new keeps', () => {
    const summary = parseFilterLog(FILTER_LOG)
    assert.deepEqual(summary, {
      changed: 308,
      kept: 36,
      ignored: 84,
      flapping: 0,
      contested: 0,
      outOfScope: 188,
      scopeAffected: 92,
      branchOwned: 0,
      ignoredZeroPx: 2,
      keptNew: 1,
      unfiltered: false,
    })
  })

  it('parses the no-change and label-bypass filter outcomes', () => {
    assert.equal(
      parseFilterLog('x\n2026-10-15T01:15:16Z screenshot filter: no changed reference screenshots')
        ?.changed,
      0,
    )
    const all = parseFilterLog(
      '2026-10-15T01:15:16Z screenshot filter: update-screenshots label present — keeping all 1274 changed shot(s) unfiltered',
    )
    assert.ok(all)
    assert.equal(all.unfiltered, true)
    assert.equal(all.kept, 1274)
    assert.equal(parseFilterLog('nothing here'), null)
    assert.equal(
      parseFilterLog(FILTER_LOG.replace('scope=92 affected + 0 branch-owned', 'scope=disabled'))
        ?.scopeAffected,
      null,
    )
  })

  it('parses the oracle plan mode, bypass reason and subset size', () => {
    const subset = parseOraclePlan(
      [
        '2026-10-15T01:03:00Z mode=subset',
        '2026-10-15T01:03:33Z mode=subset -> 34 spec(s) on 8 shard(s)',
      ].join('\n'),
    )
    assert.deepEqual(subset, { mode: 'subset', reason: 'oracle', specs: 34 })
    const echoed = parseOraclePlan(
      [
        '2026-10-15T01:03:00Z \u001b[36;1m  echo "No base sha for $EVENT -> full e2e suite"\u001b[0m',
        '2026-10-15T01:03:00Z \u001b[36;1mecho "mode=skip"\u001b[0m',
        '2026-10-15T01:03:01Z mode=full',
      ].join('\n'),
    )
    assert.deepEqual(echoed, { mode: 'full', reason: 'oracle', specs: null })
    const label = parseOraclePlan(
      '2026-10-15T01:03:00Z ci-full label -> full e2e suite (oracle bypassed on request)\n2026-10-15T01:03:00Z mode=full',
    )
    assert.deepEqual(label, { mode: 'full', reason: 'ci-full-label', specs: null })
    const skip = parseOraclePlan(
      '2026-10-15T01:03:00Z HEAD commit only refreshes reference screenshots -> skip e2e\n2026-10-15T01:03:00Z mode=skip -> no e2e shards dispatched',
    )
    assert.deepEqual(skip, { mode: 'skip', reason: 'screenshot-only-commit', specs: null })
    assert.equal(parseOraclePlan('no plan'), null)
  })

  it('matches a publisher run by completion time, never by its reported head', () => {
    const ciRun: Run = {
      id: 1,
      head_sha: 'a'.repeat(40),
      head_branch: 'feature',
      run_attempt: 1,
      status: 'completed',
      conclusion: 'success',
      event: 'pull_request',
      created_at: T(0),
      run_started_at: T(0),
      updated_at: T(20),
    }
    const publisher = (id: number, created: string): Run => ({
      ...ciRun,
      id,
      head_sha: 'f'.repeat(40),
      head_branch: 'main',
      event: 'workflow_run',
      created_at: created,
      run_started_at: created,
    })
    assert.equal(
      matchPublisherRun(ciRun, [publisher(2, T(10)), publisher(3, T(21)), publisher(4, T(22))])?.id,
      3,
    )
    assert.equal(matchPublisherRun(ciRun, [publisher(5, T(30))]), undefined)
  })

  it('summarizes e2e shards, runner labels and job timing from the jobs API', () => {
    const summary = summarizeJobs([
      job({ id: 1, name: 'precheck', started_at: T(0), completed_at: T(6) }),
      job({
        id: 2,
        name: 'e2e (1)',
        started_at: T(10),
        completed_at: T(13),
        labels: ['self-hosted', 'copse-e2e'],
      }),
      job({
        id: 3,
        name: 'e2e (2)',
        started_at: T(10),
        completed_at: T(15),
        labels: ['self-hosted', 'copse-e2e'],
      }),
      job({
        id: 4,
        name: 'bench',
        conclusion: 'skipped',
        started_at: null,
        completed_at: null,
        labels: [],
      }),
      job({ id: 5, name: 'screenshot-artifacts', started_at: T(15), completed_at: T(18) }),
    ])
    assert.equal(summary.runMinutes, 18)
    assert.deepEqual(summary.e2e, {
      shards: 2,
      wallMinutes: 5,
      runnerMinutes: 8,
      labels: ['copse-e2e', 'self-hosted'],
      runnerKind: 'self-hosted',
    })
    assert.equal(summary.precheckJobId, 1)
    assert.deepEqual(summary.screenshotArtifacts, { jobId: 5, minutes: 3 })
    const none = summarizeJobs([job({ id: 1 })])
    assert.equal(none.e2e.runnerKind, 'none')
    assert.equal(none.screenshotArtifacts, null)
  })

  it('prefers the latest successful run and the latest parsed filter for candidates', () => {
    const failed = run({
      id: 2,
      conclusion: 'failure',
      createdAt: T(20),
      filter: null,
      logs: { precheck: 'parsed', filter: 'not-run' },
    })
    const p = pull({ runs: [run({}), failed] })
    assert.equal(representativeRun(p)?.id, 1)
    const skipAfter = pull({
      runs: [
        run({}),
        run({
          id: 5,
          createdAt: T(40),
          filter: null,
          logs: { precheck: 'parsed', filter: 'not-run' },
        }),
      ],
    })
    assert.equal(
      representativeRun(skipAfter)?.id,
      1,
      'a screenshot-only follow-up run carries no verdicts',
    )
    assert.equal(candidatesForPull(p), 36)
    const unparsed = pull({
      runs: [run({ filter: null, logs: { precheck: 'unavailable', filter: 'unavailable' } })],
      compare: { heads: 1, candidates: 7 },
    })
    assert.equal(candidatesForPull(unparsed), 7)
    assert.equal(
      candidatesForPull(pull({ runs: [], compare: { heads: 0, candidates: null } })),
      null,
    )
  })

  it('aggregates by oracle mode, runner label and label usage', () => {
    const report = aggregate('copse-dev/agent-pane', [
      pull({ labelsEver: ['ci-full', 'screenshots-need-review'] }),
      pull({
        number: 3747,
        runs: [
          run({
            id: 3,
            plan: { mode: 'full', reason: 'ci-full-label', specs: null },
            jobs: {
              runMinutes: 25,
              e2e: {
                shards: 8,
                wallMinutes: 9,
                runnerMinutes: 60,
                labels: ['self-hosted', 'copse-e2e'],
                runnerKind: 'self-hosted',
              },
              precheckJobId: 1,
              screenshotArtifacts: { jobId: 2, minutes: 4 },
            },
            filter: {
              changed: 900,
              kept: 120,
              ignored: 500,
              flapping: 3,
              contested: 1,
              outOfScope: 276,
              scopeAffected: null,
              branchOwned: null,
              ignoredZeroPx: 400,
              keptNew: 0,
              unfiltered: false,
            },
            publisher: null,
          }),
        ],
        compare: { heads: 0, candidates: null },
      }),
      pull({
        number: 3750,
        runs: [
          run({
            id: 4,
            filter: null,
            logs: { precheck: 'unavailable', filter: 'unavailable' },
            plan: null,
            jobs: {
              runMinutes: 5,
              e2e: {
                shards: 0,
                wallMinutes: null,
                runnerMinutes: 0,
                labels: [],
                runnerKind: 'none',
              },
              precheckJobId: null,
              screenshotArtifacts: null,
            },
          }),
        ],
        compare: { heads: 0, candidates: null },
      }),
    ])
    const s = report.summary
    assert.equal(s.pulls, 3)
    assert.deepEqual(s.candidatesPerPull, {
      measured: 2,
      median: 120,
      p90: 120,
      max: 120,
      over50: 1,
      zero: 0,
    })
    assert.equal(s.byMode['subset']?.runs, 1)
    assert.equal(s.byMode['full']?.e2eRunnerMinutes, 60)
    assert.equal(s.byMode['skip (inferred)']?.runs, 1)
    assert.equal(s.byRunner['self-hosted+copse-e2e']?.renderedChangedMean, 900)
    assert.equal(s.byRunner['ubuntu-latest']?.keptMean, 36)
    assert.deepEqual(s.filterTotals, {
      changed: 1208,
      kept: 156,
      ignored: 584,
      ignoredZeroPx: 460,
      flapping: 3,
      contested: 1,
      outOfScope: 464,
      runs: 2,
    })
    assert.equal(s.labels['ci-full'], 1)
    assert.equal(s.labels['update-screenshots'], 0)
    assert.deepEqual(s.publisher, {
      runs: 0,
      failures: 0,
      skipped: 0,
      medianMinutes: null,
      p90Minutes: null,
    })
    assert.deepEqual(s.byConclusion['success'], {
      runs: 3,
      e2eRunnerMinutes: 80,
      runMinutesMean: 16,
    })
    assert.deepEqual(s.logs, {
      filterParsed: 2,
      filterUnavailable: 1,
      planParsed: 2,
      planUnavailable: 1,
    })
    const markdown = renderMarkdown(report)
    assert.match(
      markdown,
      /\| #3747 \| yes \| — \| 1 \| full \(ci-full-label\) \| 8 \| self-hosted\+copse-e2e \| 9 \| 900 \| 120 \| 500 \(400\) \| 276 \| 120 \| n\/a \|/,
    )
    assert.match(markdown, /1 PR\(s\) over 50/)
  })
})
