/**
 * Read-only baseline of screenshot review amplification.
 *
 * Given an authenticated `gh`, pulls the last N same-repository PRs against
 * `main`, every completed CI run on each PR branch, the runs' jobs and
 * artifacts, the trusted publisher's runs, and — where GitHub still serves
 * them — the `precheck` and `screenshot-artifacts` job logs, which carry the
 * oracle plan and the noise filter's verdict counts. Historical artifacts
 * expire within days, so job logs (90-day retention) and run metadata are
 * the durable sources; `screenshot-compare/pr-<N>/<sha12>` branches add the
 * exact published candidate count for a PR's latest reviewed head.
 *
 * It changes nothing on GitHub and nothing in the checkout except fetched
 * objects (compare commits) and a local log cache. It is a measurement aid for
 * docs/plans work, not a gate.
 *
 * Usage:
 *   node scripts/screenshot-metrics-baseline.mts --repo copse-dev/agent-pane --prs 30 \
 *     [--pulls 3773,3758,...] [--logs-dir .cache/screenshot-metrics/logs] \
 *     [--json out.json] [--markdown out.md] [--no-logs] [--no-compare]
 *
 * `--pulls` pins the PR set (the closed-PR listing drifts as PRs close), so a
 * baseline can be re-run against the same PRs after fixing a parser.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { isDirectExecution } from './lib/direct-execution.mts'
import { decodeWithSchema, safeJsonParse, type JsonDecoder } from './lib/safe-json.mts'
import { manifestAtRef } from './lib/screenshot-git.mts'
import { changedManifestNames } from './lib/screenshot-manifest.mts'

const TRACKED_LABELS = [
  'ci-full',
  'update-screenshots',
  'screenshots-need-review',
  'accept-screenshots',
  'decline-screenshots',
] as const

const pullSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  draft: z.boolean().optional(),
  created_at: z.string(),
  closed_at: z.string().nullable(),
  merged_at: z.string().nullable(),
  labels: z.array(z.object({ name: z.string() })),
  head: z.object({
    ref: z.string(),
    sha: z.string(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
  user: z.object({ login: z.string() }).nullable(),
})
const eventSchema = z.object({
  event: z.string(),
  label: z.object({ name: z.string() }).optional(),
})
const runSchema = z.object({
  id: z.number().int(),
  head_sha: z.string(),
  head_branch: z.string().nullable(),
  run_attempt: z.number().int(),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  event: z.string(),
  created_at: z.string(),
  run_started_at: z.string().optional(),
  updated_at: z.string(),
})
const runListSchema = z.object({ workflow_runs: z.array(runSchema) })
export const jobSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  conclusion: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  labels: z.array(z.string()),
  runner_name: z.string().nullable(),
})
const jobListSchema = z.object({ jobs: z.array(jobSchema) })
const artifactSchema = z.object({
  name: z.string(),
  size_in_bytes: z.number(),
  expired: z.boolean(),
  expires_at: z.string().nullable(),
})
const artifactListSchema = z.object({ artifacts: z.array(artifactSchema) })

export type Job = z.infer<typeof jobSchema>
export type Run = z.infer<typeof runSchema>

export interface FilterSummary {
  changed: number
  kept: number
  ignored: number
  flapping: number
  contested: number
  outOfScope: number
  /** Shots the oracle maps to this diff; null when scoping was disabled. */
  scopeAffected: number | null
  branchOwned: number | null
  /** Ignored shots whose pixels were identical (bytes differed only). */
  ignoredZeroPx: number
  keptNew: number
  /** `update-screenshots` kept everything unfiltered. */
  unfiltered: boolean
}

export interface OraclePlan {
  mode: 'full' | 'subset' | 'skip'
  /** Why the plan bypassed the oracle (label, stack tip, …); 'oracle' otherwise. */
  reason: string
  specs: number | null
}

export interface JobsSummary {
  runMinutes: number | null
  e2e: {
    shards: number
    wallMinutes: number | null
    runnerMinutes: number
    labels: string[]
    runnerKind: 'hosted' | 'self-hosted' | 'none'
  }
  precheckJobId: number | null
  screenshotArtifacts: { jobId: number; minutes: number | null } | null
}

export interface RunBaseline {
  id: number
  headSha: string
  attempt: number
  conclusion: string | null
  createdAt: string
  jobs: JobsSummary
  artifacts: { candidates: { bytes: number; expired: boolean } | null; shardBytes: number }
  publisher: { id: number; conclusion: string | null; minutes: number | null } | null
  plan: OraclePlan | null
  filter: FilterSummary | null
  logs: {
    precheck: 'parsed' | 'unavailable' | 'unparsed'
    filter: 'parsed' | 'unavailable' | 'unparsed' | 'not-run'
  }
}

export interface PullBaseline {
  number: number
  title: string
  author: string
  createdAt: string
  closedAt: string | null
  merged: boolean
  hoursOpen: number | null
  labelsEver: string[]
  runs: RunBaseline[]
  compare: { heads: number; candidates: number | null }
}

/** Strip the `2026-10-15T01:15:16.3937470Z ` prefix GitHub puts on log lines. */
/**
 * Log lines without their `2026-10-15T01:15:16.3937470Z ` prefix. GitHub also
 * echoes every `run:` script body in cyan before executing it; those lines
 * are dropped so an `echo "mode=full"` in the script is never read as output.
 */
export function logLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.includes('\u001b[36;1m'))
    .map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z ?/, ''))
}

const FILTER_LINE =
  /screenshot filter: (\d+) changed, (\d+) kept \(real\), (\d+) ignored \(noise\), (\d+) held \(flapping\), (\d+) held \(contested\), (\d+) held \(out of scope\) \[.*?scope=(?:(\d+) affected \+ (\d+) branch-owned|disabled)\]/

export function parseFilterLog(text: string): FilterSummary | null {
  const lines = logLines(text)
  let summary: FilterSummary | null = null
  let ignoredZeroPx = 0
  let keptNew = 0
  for (const line of lines) {
    const match = FILTER_LINE.exec(line)
    if (match) {
      const n = (index: number): number => Number(match[index] ?? 0)
      summary = {
        changed: n(1),
        kept: n(2),
        ignored: n(3),
        flapping: n(4),
        contested: n(5),
        outOfScope: n(6),
        scopeAffected: match[7] === undefined ? null : n(7),
        branchOwned: match[8] === undefined ? null : n(8),
        ignoredZeroPx: 0,
        keptNew: 0,
        unfiltered: false,
      }
      continue
    }
    const unfiltered = /update-screenshots label present — keeping all (\d+) changed/.exec(line)
    if (unfiltered) {
      const changed = Number(unfiltered[1])
      summary = {
        changed,
        kept: changed,
        ignored: 0,
        flapping: 0,
        contested: 0,
        outOfScope: 0,
        scopeAffected: null,
        branchOwned: null,
        ignoredZeroPx: 0,
        keptNew: 0,
        unfiltered: true,
      }
      continue
    }
    if (/screenshot filter: no changed reference screenshots/.test(line)) {
      summary = {
        changed: 0,
        kept: 0,
        ignored: 0,
        flapping: 0,
        contested: 0,
        outOfScope: 0,
        scopeAffected: null,
        branchOwned: null,
        ignoredZeroPx: 0,
        keptNew: 0,
        unfiltered: false,
      }
      continue
    }
    if (/^\s+ignore tests\/e2e\/screenshots\/\S+ \(0 px, /.test(line)) ignoredZeroPx += 1
    if (/^\s+keep {3}tests\/e2e\/screenshots\/\S+ \(new screenshot/.test(line)) keptNew += 1
  }
  return summary ? { ...summary, ignoredZeroPx, keptNew } : null
}

const PLAN_REASONS: Array<[RegExp, string]> = [
  [/Nightly schedule -> full/, 'schedule'],
  [/Declared screenshot stack tip -> full/, 'stack-tip'],
  [/HEAD commit only refreshes reference screenshots -> skip/, 'screenshot-only-commit'],
  [/PR targets release -> full/, 'release-promotion'],
  [/update-screenshots label -> full/, 'update-screenshots-label'],
  [/ci-full label -> full/, 'ci-full-label'],
  [/No base sha for \S+ -> full/, 'no-base-sha'],
]

export function parseOraclePlan(text: string): OraclePlan | null {
  const lines = logLines(text)
  let mode: OraclePlan['mode'] | null = null
  let reason = 'oracle'
  let specs: number | null = null
  for (const line of lines) {
    const modeLine = /^mode=(full|subset|skip)\b/.exec(line)
    if (modeLine?.[1] === 'full' || modeLine?.[1] === 'subset' || modeLine?.[1] === 'skip') {
      mode = modeLine[1]
    }
    const subset = /^mode=subset -> (\d+) spec\(s\) on \d+ shard\(s\)/.exec(line)
    if (subset) specs = Number(subset[1])
    for (const [pattern, label] of PLAN_REASONS) if (pattern.test(line)) reason = label
  }
  return mode ? { mode, reason, specs } : null
}

function minutes(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null
  const ms = Date.parse(to) - Date.parse(from)
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 6000) / 10 : null
}

function span(jobs: readonly Job[]): number | null {
  const started = jobs
    .map((job) => job.started_at)
    .filter((value) => value !== null)
    .sort()
  const completed = jobs
    .map((job) => job.completed_at)
    .filter((value) => value !== null)
    .sort()
  return minutes(started[0], completed.at(-1))
}

export function summarizeJobs(jobs: readonly Job[]): JobsSummary {
  const ran = jobs.filter((job) => job.conclusion !== 'skipped' && job.started_at !== null)
  const e2e = ran.filter((job) => /^e2e \(\d+\)$/.test(job.name))
  const labels = [...new Set(e2e.flatMap((job) => job.labels))].sort()
  const screenshotArtifacts = ran.find((job) => job.name === 'screenshot-artifacts')
  const precheck = jobs.find((job) => job.name === 'precheck')
  return {
    runMinutes: span(ran),
    e2e: {
      shards: e2e.length,
      wallMinutes: span(e2e),
      runnerMinutes: e2e.reduce(
        (sum, job) => sum + (minutes(job.started_at, job.completed_at) ?? 0),
        0,
      ),
      labels,
      runnerKind:
        e2e.length === 0 ? 'none' : labels.includes('self-hosted') ? 'self-hosted' : 'hosted',
    },
    precheckJobId: precheck?.id ?? null,
    screenshotArtifacts: screenshotArtifacts
      ? {
          jobId: screenshotArtifacts.id,
          minutes: minutes(screenshotArtifacts.started_at, screenshotArtifacts.completed_at),
        }
      : null,
  }
}

export interface BaselineReport {
  repository: string
  generatedAt: string
  pulls: PullBaseline[]
  summary: {
    pulls: number
    merged: number
    runsPerPull: { median: number; max: number }
    candidatesPerPull: {
      measured: number
      median: number
      p90: number
      max: number
      over50: number
      zero: number
    }
    renderedChangedPerRun: { measured: number; median: number; p90: number; max: number }
    byMode: Record<
      string,
      {
        runs: number
        e2eWallMinutesMean: number | null
        e2eRunnerMinutes: number
        renderedChangedMean: number | null
        keptMean: number | null
      }
    >
    byRunner: Record<
      string,
      {
        runs: number
        renderedChangedMean: number | null
        ignoredMean: number | null
        keptMean: number | null
        outOfScopeMean: number | null
      }
    >
    filterTotals: {
      changed: number
      kept: number
      ignored: number
      ignoredZeroPx: number
      flapping: number
      contested: number
      outOfScope: number
      runs: number
    }
    labels: Record<string, number>
    byConclusion: Record<
      string,
      { runs: number; e2eRunnerMinutes: number; runMinutesMean: number | null }
    >
    /** Every publisher run in the collection window, independent of per-run matching. */
    publisher: {
      runs: number
      failures: number
      skipped: number
      medianMinutes: number | null
      p90Minutes: number | null
    }
    logs: {
      filterParsed: number
      filterUnavailable: number
      planParsed: number
      planUnavailable: number
    }
  }
}

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
}

function mean(values: readonly number[]): number | null {
  return values.length
    ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10
    : null
}

/** The run whose evidence a reviewer saw last: latest with filter verdicts, else latest successful, else latest. */
export function representativeRun(pull: PullBaseline): RunBaseline | null {
  const sorted = [...pull.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return (
    sorted.find((run) => run.filter !== null) ??
    sorted.find((run) => run.conclusion === 'success') ??
    sorted[0] ??
    null
  )
}

/** Candidates a PR presented for review, from the best available evidence. */
export function candidatesForPull(pull: PullBaseline): number | null {
  const filtered = pull.runs
    .filter((run) => run.filter !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const latest = filtered[0]?.filter
  if (latest) return latest.kept
  return pull.compare.candidates
}

/**
 * The run's oracle mode: parsed from the precheck log when available, else
 * inferred from the shard count where that is unambiguous (zero shards is a
 * skip; fewer than eight is a subset; eight could be either).
 */
export function modeOf(run: RunBaseline): string {
  if (run.plan) return run.plan.mode
  if (run.jobs.e2e.shards === 0) return 'skip (inferred)'
  if (run.jobs.e2e.shards < 8) return 'subset (inferred)'
  return 'unknown'
}

export function aggregate(
  repository: string,
  pulls: PullBaseline[],
  publisherRuns: readonly Run[] = [],
): BaselineReport {
  const runs = pulls.flatMap((pull) => pull.runs)
  const withFilter = runs.flatMap((run) => (run.filter ? [{ run, filter: run.filter }] : []))
  const candidates = pulls.flatMap((pull) => {
    const count = candidatesForPull(pull)
    return count === null ? [] : [count]
  })
  const byConclusion: BaselineReport['summary']['byConclusion'] = {}
  for (const run of runs) {
    const bucket = (byConclusion[run.conclusion ?? 'unknown'] ??= {
      runs: 0,
      e2eRunnerMinutes: 0,
      runMinutesMean: null,
    })
    bucket.runs += 1
    bucket.e2eRunnerMinutes =
      Math.round((bucket.e2eRunnerMinutes + run.jobs.e2e.runnerMinutes) * 10) / 10
  }
  for (const [conclusion, bucket] of Object.entries(byConclusion)) {
    bucket.runMinutesMean = mean(
      runs.flatMap((run) =>
        (run.conclusion ?? 'unknown') === conclusion && run.jobs.runMinutes !== null
          ? [run.jobs.runMinutes]
          : [],
      ),
    )
  }
  // Oracle mode is only knowable for completed, successful runs (their logs and
  // shard counts are final); failed and cancelled runs are costed above.
  const successful = runs.filter((run) => run.conclusion === 'success')
  const byMode: BaselineReport['summary']['byMode'] = {}
  for (const run of successful) {
    const mode = modeOf(run)
    const bucket = (byMode[mode] ??= {
      runs: 0,
      e2eWallMinutesMean: null,
      e2eRunnerMinutes: 0,
      renderedChangedMean: null,
      keptMean: null,
    })
    bucket.runs += 1
    bucket.e2eRunnerMinutes =
      Math.round((bucket.e2eRunnerMinutes + run.jobs.e2e.runnerMinutes) * 10) / 10
  }
  for (const [mode, bucket] of Object.entries(byMode)) {
    const group = successful.filter((run) => modeOf(run) === mode)
    bucket.e2eWallMinutesMean = mean(
      group.flatMap((run) => (run.jobs.e2e.wallMinutes === null ? [] : [run.jobs.e2e.wallMinutes])),
    )
    bucket.renderedChangedMean = mean(
      group.flatMap((run) => (run.filter ? [run.filter.changed] : [])),
    )
    bucket.keptMean = mean(group.flatMap((run) => (run.filter ? [run.filter.kept] : [])))
  }
  const byRunner: BaselineReport['summary']['byRunner'] = {}
  for (const run of runs) {
    if (run.jobs.e2e.shards === 0) continue
    const key = run.jobs.e2e.labels.join('+') || run.jobs.e2e.runnerKind
    const group = (byRunner[key] ??= {
      runs: 0,
      renderedChangedMean: null,
      ignoredMean: null,
      keptMean: null,
      outOfScopeMean: null,
    })
    group.runs += 1
  }
  for (const [key, group] of Object.entries(byRunner)) {
    const filters = withFilter
      .filter(({ run }) => (run.jobs.e2e.labels.join('+') || run.jobs.e2e.runnerKind) === key)
      .map(({ filter }) => filter)
    group.renderedChangedMean = mean(filters.map((filter) => filter.changed))
    group.ignoredMean = mean(filters.map((filter) => filter.ignored))
    group.keptMean = mean(filters.map((filter) => filter.kept))
    group.outOfScopeMean = mean(filters.map((filter) => filter.outOfScope))
  }
  const sum = (pick: (filter: FilterSummary) => number): number =>
    withFilter.reduce((total, { filter }) => total + pick(filter), 0)
  const labels: Record<string, number> = {}
  for (const label of TRACKED_LABELS)
    labels[label] = pulls.filter((pull) => pull.labelsEver.includes(label)).length
  const publisherMinutes = publisherRuns.flatMap((run) => {
    const value = minutes(run.run_started_at, run.updated_at)
    return run.conclusion === 'success' && value !== null ? [value] : []
  })
  const rendered = withFilter.map(({ filter }) => filter.changed)
  return {
    repository,
    generatedAt: new Date().toISOString(),
    pulls,
    summary: {
      pulls: pulls.length,
      merged: pulls.filter((pull) => pull.merged).length,
      runsPerPull: {
        median: quantile(
          pulls.map((pull) => pull.runs.length),
          0.5,
        ),
        max: Math.max(0, ...pulls.map((pull) => pull.runs.length)),
      },
      candidatesPerPull: {
        measured: candidates.length,
        median: quantile(candidates, 0.5),
        p90: quantile(candidates, 0.9),
        max: Math.max(0, ...candidates),
        over50: candidates.filter((count) => count > 50).length,
        zero: candidates.filter((count) => count === 0).length,
      },
      renderedChangedPerRun: {
        measured: rendered.length,
        median: quantile(rendered, 0.5),
        p90: quantile(rendered, 0.9),
        max: Math.max(0, ...rendered),
      },
      byMode,
      byRunner,
      filterTotals: {
        changed: sum((filter) => filter.changed),
        kept: sum((filter) => filter.kept),
        ignored: sum((filter) => filter.ignored),
        ignoredZeroPx: sum((filter) => filter.ignoredZeroPx),
        flapping: sum((filter) => filter.flapping),
        contested: sum((filter) => filter.contested),
        outOfScope: sum((filter) => filter.outOfScope),
        runs: withFilter.length,
      },
      labels,
      byConclusion,
      publisher: {
        runs: publisherRuns.length,
        failures: publisherRuns.filter((run) => run.conclusion === 'failure').length,
        skipped: publisherRuns.filter((run) => run.conclusion === 'skipped').length,
        medianMinutes: publisherMinutes.length ? quantile(publisherMinutes, 0.5) : null,
        p90Minutes: publisherMinutes.length ? quantile(publisherMinutes, 0.9) : null,
      },
      logs: {
        filterParsed: runs.filter((run) => run.logs.filter === 'parsed').length,
        filterUnavailable: runs.filter((run) => run.logs.filter === 'unavailable').length,
        planParsed: runs.filter((run) => run.logs.precheck === 'parsed').length,
        planUnavailable: runs.filter((run) => run.logs.precheck === 'unavailable').length,
      },
    },
  }
}

const na = (value: number | null | undefined): string =>
  value === null || value === undefined ? 'n/a' : String(value)

export function renderMarkdown(report: BaselineReport): string {
  const s = report.summary
  const lines = [
    `### Screenshot review baseline — ${report.repository}, last ${String(s.pulls)} PRs (${String(s.merged)} merged)`,
    '',
    `Generated ${report.generatedAt}. Candidates per PR: median ${String(s.candidatesPerPull.median)}, p90 ${String(s.candidatesPerPull.p90)}, max ${String(s.candidatesPerPull.max)}; ${String(s.candidatesPerPull.over50)} PR(s) over 50, ${String(s.candidatesPerPull.zero)} with none (${String(s.candidatesPerPull.measured)} measurable). Rendered-differently per run: median ${String(s.renderedChangedPerRun.median)}, p90 ${String(s.renderedChangedPerRun.p90)}, max ${String(s.renderedChangedPerRun.max)} (${String(s.renderedChangedPerRun.measured)} runs with a parsed filter log).`,
    '',
    `Filter totals over ${String(s.filterTotals.runs)} runs: ${String(s.filterTotals.changed)} rendered differently → ${String(s.filterTotals.kept)} kept, ${String(s.filterTotals.ignored)} ignored (${String(s.filterTotals.ignoredZeroPx)} pixel-identical), ${String(s.filterTotals.flapping)} flapping, ${String(s.filterTotals.contested)} contested, ${String(s.filterTotals.outOfScope)} out of scope.`,
    '',
    `Labels ever applied: ${TRACKED_LABELS.map((label) => `${label} ${String(s.labels[label] ?? 0)}`).join(', ')}. Publisher (all runs in window): ${String(s.publisher.runs)} runs, ${String(s.publisher.failures)} failed, ${String(s.publisher.skipped)} skipped, successful median ${na(s.publisher.medianMinutes)} min, p90 ${na(s.publisher.p90Minutes)} min. Logs: filter parsed ${String(s.logs.filterParsed)} / unavailable ${String(s.logs.filterUnavailable)}; plan parsed ${String(s.logs.planParsed)} / unavailable ${String(s.logs.planUnavailable)}.`,
    '',
    '| CI conclusion | Runs | Run wall min (mean) | e2e runner min (sum) |',
    '| --- | --- | --- | --- |',
    ...Object.entries(s.byConclusion).map(
      ([conclusion, bucket]) =>
        `| ${conclusion} | ${String(bucket.runs)} | ${na(bucket.runMinutesMean)} | ${String(bucket.e2eRunnerMinutes)} |`,
    ),
    '',
    '| Oracle mode (successful runs) | Runs | e2e wall min (mean) | e2e runner min (sum) | Rendered differently (mean) | Kept (mean) |',
    '| --- | --- | --- | --- | --- | --- |',
    ...Object.entries(s.byMode).map(
      ([mode, bucket]) =>
        `| ${mode} | ${String(bucket.runs)} | ${na(bucket.e2eWallMinutesMean)} | ${String(bucket.e2eRunnerMinutes)} | ${na(bucket.renderedChangedMean)} | ${na(bucket.keptMean)} |`,
    ),
    '',
    '| e2e runner labels | Runs | Rendered differently (mean) | Ignored (mean) | Out of scope (mean) | Kept (mean) |',
    '| --- | --- | --- | --- | --- | --- |',
    ...Object.entries(s.byRunner).map(
      ([key, group]) =>
        `| ${key} | ${String(group.runs)} | ${na(group.renderedChangedMean)} | ${na(group.ignoredMean)} | ${na(group.outOfScopeMean)} | ${na(group.keptMean)} |`,
    ),
    '',
    '| PR | Merged | Labels ever | Runs | Mode (latest) | Shards | Runner | e2e wall min | Rendered | Kept | Ignored (0 px) | Out of scope | Candidates | Publisher min |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.pulls
      .map((pull) => {
        const run = representativeRun(pull)
        const filter = run?.filter ?? null
        return [
          `#${String(pull.number)}`,
          pull.merged ? 'yes' : 'no',
          pull.labelsEver.join(', ') || '—',
          String(pull.runs.length),
          run?.plan
            ? `${run.plan.mode}${run.plan.reason === 'oracle' ? '' : ` (${run.plan.reason})`}`
            : 'n/a',
          run ? String(run.jobs.e2e.shards) : 'n/a',
          run ? run.jobs.e2e.labels.join('+') || run.jobs.e2e.runnerKind : 'n/a',
          na(run?.jobs.e2e.wallMinutes),
          filter ? String(filter.changed) : 'n/a',
          filter ? String(filter.kept) : 'n/a',
          filter ? `${String(filter.ignored)} (${String(filter.ignoredZeroPx)})` : 'n/a',
          filter ? String(filter.outOfScope) : 'n/a',
          na(candidatesForPull(pull)),
          na(run?.publisher?.minutes),
        ].join(' | ')
      })
      .map((row) => `| ${row} |`),
    '',
  ]
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Collection (gh + git). Everything below talks to the network.

interface Options {
  repository: string
  prs: number
  /** Explicit PR numbers instead of the last `prs` closed PRs. */
  pulls: number[]
  logsDir: string
  fetchLogs: boolean
  fetchCompare: boolean
  json: string | null
  markdown: string | null
}

function gh(path: string, text = false): string | null {
  try {
    return execFileSync('gh', ['api', path], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', text ? 'ignore' : 'pipe'],
    })
  } catch {
    return null
  }
}

function fetchJson<T>(path: string, decoder: JsonDecoder<T>): T | null {
  const text = gh(path)
  return text === null ? null : safeJsonParse(text, decoder)
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

/** A job log from the local cache, else from GitHub (cached on success). */
function jobLog(options: Options, jobId: number): string | null {
  const cached = join(options.logsDir, `${String(jobId)}.txt`)
  if (existsSync(cached)) return readFileSync(cached, 'utf8')
  if (!options.fetchLogs) return null
  const text = gh(`repos/${options.repository}/actions/jobs/${String(jobId)}/logs`, true)
  if (text === null || text.length === 0) return null
  mkdirSync(options.logsDir, { recursive: true })
  writeFileSync(cached, text)
  return text
}

function compareCandidates(options: Options, number: number): PullBaseline['compare'] {
  const remote = `https://github.com/${options.repository}.git`
  const refs = git(['ls-remote', remote, `refs/heads/screenshot-compare/pr-${String(number)}/*`])
  const heads = (refs ?? '').split('\n').flatMap((line) => {
    const [sha] = line.split(/\s+/)
    return sha && /^[0-9a-f]{40}$/.test(sha) ? [sha] : []
  })
  if (!options.fetchCompare || heads.length === 0) return { heads: heads.length, candidates: null }
  const counts = heads.flatMap((sha) => {
    // The compare commit's sole parent is the rendered head; depth 2 brings both.
    if (git(['fetch', '--quiet', '--no-tags', '--depth=2', remote, sha]) === null) return []
    const after = manifestAtRef(sha)
    const before = manifestAtRef(`${sha}^`)
    return after && before ? [changedManifestNames(before, after).length] : []
  })
  return { heads: heads.length, candidates: counts.length ? Math.max(...counts) : null }
}

/**
 * The publisher run a CI run triggered. A `workflow_run` run reports the
 * default branch's head, not the PR's, so the match is by time: the first
 * publisher run created within three minutes after the CI run completed.
 * Concurrent CI runs can mis-attribute, so per-PR publisher minutes are
 * approximate; the global publisher summary does not depend on this.
 */
export function matchPublisherRun(run: Run, publisherRuns: readonly Run[]): Run | undefined {
  const completed = Date.parse(run.updated_at)
  return [...publisherRuns]
    .filter((candidate) => {
      const created = Date.parse(candidate.created_at)
      return created >= completed - 30_000 && created <= completed + 180_000
    })
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0]
}

function collectRun(options: Options, run: Run, publisherRuns: readonly Run[]): RunBaseline {
  const jobs =
    fetchJson(
      `repos/${options.repository}/actions/runs/${String(run.id)}/jobs?per_page=100`,
      decodeWithSchema(jobListSchema),
    )?.jobs ?? []
  const artifacts =
    fetchJson(
      `repos/${options.repository}/actions/runs/${String(run.id)}/artifacts?per_page=100`,
      decodeWithSchema(artifactListSchema),
    )?.artifacts ?? []
  const summary = summarizeJobs(jobs)
  const candidates = artifacts.find(
    (artifact) => artifact.name === `reference-screenshot-candidates-${String(run.id)}`,
  )
  const shardBytes = artifacts
    .filter((artifact) => /^screenshots-shard-\d+$/.test(artifact.name))
    .reduce((sum, artifact) => sum + artifact.size_in_bytes, 0)
  const publisher = matchPublisherRun(run, publisherRuns)
  let plan: OraclePlan | null = null
  let precheckStatus: RunBaseline['logs']['precheck'] = 'unavailable'
  if (summary.precheckJobId !== null) {
    const log = jobLog(options, summary.precheckJobId)
    if (log !== null) {
      plan = parseOraclePlan(log)
      precheckStatus = plan ? 'parsed' : 'unparsed'
    }
  }
  let filter: FilterSummary | null = null
  let filterStatus: RunBaseline['logs']['filter'] = 'not-run'
  if (summary.screenshotArtifacts) {
    const log = jobLog(options, summary.screenshotArtifacts.jobId)
    if (log === null) filterStatus = 'unavailable'
    else {
      filter = parseFilterLog(log)
      filterStatus = filter ? 'parsed' : 'unparsed'
    }
  }
  return {
    id: run.id,
    headSha: run.head_sha,
    attempt: run.run_attempt,
    conclusion: run.conclusion,
    createdAt: run.created_at,
    jobs: summary,
    artifacts: {
      candidates: candidates
        ? { bytes: candidates.size_in_bytes, expired: candidates.expired }
        : null,
      shardBytes,
    },
    publisher: publisher
      ? {
          id: publisher.id,
          conclusion: publisher.conclusion,
          minutes: minutes(publisher.run_started_at, publisher.updated_at),
        }
      : null,
    plan,
    filter,
    logs: { precheck: precheckStatus, filter: filterStatus },
  }
}

function collectPull(
  options: Options,
  pull: z.infer<typeof pullSchema>,
  publisherRuns: readonly Run[],
): PullBaseline {
  const events =
    fetchJson(
      `repos/${options.repository}/issues/${String(pull.number)}/events?per_page=100`,
      decodeWithSchema(z.array(eventSchema)),
    ) ?? []
  const labelsEver = new Set(pull.labels.map((label) => label.name))
  for (const event of events)
    if (event.event === 'labeled' && event.label) labelsEver.add(event.label.name)
  const branch = encodeURIComponent(pull.head.ref)
  const runs = (
    fetchJson(
      `repos/${options.repository}/actions/workflows/ci.yml/runs?event=pull_request&branch=${branch}&per_page=100`,
      decodeWithSchema(runListSchema),
    )?.workflow_runs ?? []
  )
    .filter((run) => run.status === 'completed' && run.created_at >= pull.created_at)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
  const closedAt = pull.merged_at ?? pull.closed_at
  return {
    number: pull.number,
    title: pull.title,
    author: pull.user?.login ?? 'unknown',
    createdAt: pull.created_at,
    closedAt,
    merged: pull.merged_at !== null,
    hoursOpen: closedAt
      ? Math.round(((Date.parse(closedAt) - Date.parse(pull.created_at)) / 3_600_000) * 10) / 10
      : null,
    labelsEver: [...labelsEver]
      .filter((label) => TRACKED_LABELS.some((tracked) => tracked === label))
      .sort(),
    runs: runs.map((run) => collectRun(options, run, publisherRuns)),
    compare: compareCandidates(options, pull.number),
  }
}

export function collectBaseline(options: Options): BaselineReport {
  const listed = options.pulls.length
    ? options.pulls.flatMap((number) => {
        const pull = fetchJson(
          `repos/${options.repository}/pulls/${String(number)}`,
          decodeWithSchema(pullSchema),
        )
        return pull ? [pull] : []
      })
    : (
        fetchJson(
          `repos/${options.repository}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100`,
          decodeWithSchema(z.array(pullSchema)),
        ) ?? []
      ).slice(0, options.prs * 2)
  const pulls = listed
    .filter((pull) => pull.head.repo?.full_name === options.repository)
    .slice(0, options.pulls.length ? listed.length : options.prs)
  const publisherRuns = [1, 2, 3].flatMap(
    (page) =>
      fetchJson(
        `repos/${options.repository}/actions/workflows/publish-screenshot-candidates.yml/runs?per_page=100&page=${String(page)}`,
        decodeWithSchema(runListSchema),
      )?.workflow_runs ?? [],
  )
  const baseline = pulls.map((pull) => {
    console.error(`collecting #${String(pull.number)} ${pull.head.ref}`)
    return collectPull(options, pull, publisherRuns)
  })
  return aggregate(options.repository, baseline, publisherRuns)
}

function parseOptions(argv: readonly string[]): Options {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const prs = Number(value('--prs') ?? '30')
  return {
    repository: value('--repo') ?? 'copse-dev/agent-pane',
    prs: Number.isSafeInteger(prs) && prs > 0 ? prs : 30,
    pulls: (value('--pulls') ?? '')
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((number) => Number.isSafeInteger(number) && number > 0),
    logsDir: value('--logs-dir') ?? '.cache/screenshot-metrics/logs',
    fetchLogs: !argv.includes('--no-logs'),
    fetchCompare: !argv.includes('--no-compare'),
    json: value('--json') ?? null,
    markdown: value('--markdown') ?? null,
  }
}

if (isDirectExecution(import.meta.url, 'screenshot-metrics-baseline')) {
  const options = parseOptions(process.argv.slice(2))
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository))
    throw new Error('--repo must be owner/name')
  const report = collectBaseline(options)
  if (options.json) writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`)
  const markdown = renderMarkdown(report)
  if (options.markdown) writeFileSync(options.markdown, markdown)
  process.stdout.write(markdown)
}
