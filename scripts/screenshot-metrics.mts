/**
 * Per-run screenshot review metrics (data only).
 *
 * Two CI entry points, both additive and non-blocking:
 *
 *   shard-record   Run by every e2e shard when it collects its changed
 *                  reference shots. Prints one JSON record (timing, runner,
 *                  oracle mode, changed count) that the shard stores in its
 *                  `.shard-N` provenance marker. The trusted publisher only
 *                  tests that marker for presence, so its content is free to
 *                  carry measurement data.
 *   run            Run by `screenshot-artifacts` after the noise filter. Reads
 *                  the shard records, the filter's counts and the surviving
 *                  candidate PNGs, and writes `screenshot-metrics.json` plus a
 *                  job-summary table. It never touches the candidate tree it
 *                  reads, so the published artifact is unchanged.
 *
 * Everything here runs PR code on the untrusted side of the screenshot
 * pipeline (docs/ci-runner-security.md): the artifact is evidence for humans
 * and for scripts/screenshot-metrics-baseline.mts, never an input to a trusted
 * decision.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { isDirectExecution } from './lib/direct-execution.mts'
import { decodeWithSchema, safeJsonParse } from './lib/safe-json.mts'
import { manifestAtRef } from './lib/screenshot-git.mts'
import { SCREENSHOT_DIRECTORY, SCREENSHOT_NAME } from './lib/screenshot-manifest.mts'

const ISO = z.iso.datetime()

export const shardRecordSchema = z.object({
  shard: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  mode: z.string(),
  jobStartedAt: ISO.nullable(),
  suiteStartedAt: ISO.nullable(),
  finishedAt: ISO,
  runner: z.object({
    environment: z.string(),
    name: z.string(),
    os: z.string(),
    arch: z.string(),
  }),
  changed: z.number().int().nonnegative(),
})
export type ShardRecord = z.infer<typeof shardRecordSchema>

export interface FilterCounts {
  /** Whether the filter ran at all (false when no shard rendered a diff). */
  ran: boolean
  /** PNGs the shards rendered differently from the baseline, before filtering. */
  renderedChanged: number
  kept: number
  ignored: number
  flapping: number
  contested: number
  outOfScope: number
  seconds: number | null
}

export interface CandidatePair {
  name: string
  beforeSha256: string | null
  sha256: string
  /** Named by a PNG or e2e spec this PR changes (the publisher's "focus"). */
  focus: boolean
}

export interface MetricsInput {
  run: {
    id: string
    attempt: number
    prNumber: number | null
    headSha: string
    baseSha: string
    labels: { ciFull: boolean; updateScreenshots: boolean }
  }
  /** Entries in the committed reference manifest at the rendered head. */
  references: number
  filter: FilterCounts
  shards: ShardRecord[]
  candidates: CandidatePair[]
}

export interface ScreenshotMetrics extends MetricsInput {
  version: 1
  plan: { mode: string | null; shardTotal: number }
  e2e: {
    /** First shard job start to last shard collection, in minutes. */
    wallMinutes: number | null
    /** First suite start (after setup) to last shard collection, in minutes. */
    suiteMinutes: number | null
    runnerEnvironments: string[]
    runnerNames: string[]
    changedCollected: number
  }
  focus: { kept: number; other: number }
  pairs: { unique: number; uniqueAfter: number; new: number }
}

function minutesBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null
  const ms = Date.parse(to) - Date.parse(from)
  return Number.isFinite(ms) ? Math.round(ms / 6000) / 10 : null
}

function earliest(values: Array<string | null>): string | null {
  const present = values.filter((value) => value !== null)
  return present.length ? (present.sort()[0] ?? null) : null
}

function latest(values: Array<string | null>): string | null {
  const present = values.filter((value) => value !== null)
  return present.length ? (present.sort().at(-1) ?? null) : null
}

/** Pure aggregation so the derived fields are testable without CI. */
export function buildScreenshotMetrics(input: MetricsInput): ScreenshotMetrics {
  const modes = new Set(input.shards.map((shard) => shard.mode))
  const totals = new Set(input.shards.map((shard) => shard.total))
  const focusKept = input.candidates.filter((candidate) => candidate.focus).length
  const pairs = new Set(
    input.candidates.map((candidate) => `${candidate.beforeSha256 ?? 'new'}:${candidate.sha256}`),
  )
  const after = new Set(input.candidates.map((candidate) => candidate.sha256))
  return {
    version: 1,
    ...input,
    plan: {
      mode: modes.size === 1 ? ([...modes][0] ?? null) : null,
      shardTotal: totals.size === 1 ? ([...totals][0] ?? input.shards.length) : input.shards.length,
    },
    e2e: {
      wallMinutes: minutesBetween(
        earliest(input.shards.map((shard) => shard.jobStartedAt)),
        latest(input.shards.map((shard) => shard.finishedAt)),
      ),
      suiteMinutes: minutesBetween(
        earliest(input.shards.map((shard) => shard.suiteStartedAt)),
        latest(input.shards.map((shard) => shard.finishedAt)),
      ),
      runnerEnvironments: [
        ...new Set(input.shards.map((shard) => shard.runner.environment)),
      ].sort(),
      runnerNames: [...new Set(input.shards.map((shard) => shard.runner.name))].sort(),
      changedCollected: input.shards.reduce((sum, shard) => sum + shard.changed, 0),
    },
    focus: { kept: focusKept, other: input.candidates.length - focusKept },
    pairs: {
      unique: pairs.size,
      uniqueAfter: after.size,
      new: input.candidates.filter((candidate) => candidate.beforeSha256 === null).length,
    },
  }
}

const SCREENSHOT_PATH = /^tests\/e2e\/screenshots\/([A-Za-z0-9][A-Za-z0-9._-]*\.png)$/
const SPEC_PATH =
  /^tests\/e2e\/(?:[A-Za-z0-9][A-Za-z0-9_-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.e2e\.ts$/
const PNG_LITERAL = /[A-Za-z0-9][A-Za-z0-9._-]*\.png/g

/**
 * Screenshot basenames a PR "touches", mirroring the trusted publisher's focus
 * rule: reference PNGs in the diff plus every literal `<name>.png` in the e2e
 * specs it changes. `readSpec` returns a spec's text or null when unreadable.
 */
export function focusNames(
  changedFiles: readonly string[],
  readSpec: (path: string) => string | null,
): Set<string> {
  const names = new Set<string>()
  for (const file of changedFiles) {
    const screenshot = SCREENSHOT_PATH.exec(file)
    if (screenshot?.[1]) names.add(screenshot[1])
    if (!SPEC_PATH.test(file)) continue
    const text = readSpec(file)
    if (text === null) continue
    for (const literal of text.match(PNG_LITERAL) ?? []) names.add(literal)
  }
  return names
}

export function renderMetricsSummary(metrics: ScreenshotMetrics): string {
  const pct = (part: number, whole: number): string =>
    whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : 'n/a'
  const rows: Array<[string, string]> = [
    ['Oracle mode', metrics.plan.mode ?? 'unknown'],
    ['e2e shards', String(metrics.plan.shardTotal)],
    ['e2e runner environments', metrics.e2e.runnerEnvironments.join(', ') || 'unknown'],
    ['e2e wall minutes (job start → last collection)', String(metrics.e2e.wallMinutes ?? 'n/a')],
    [
      'e2e suite minutes (suite start → last collection)',
      String(metrics.e2e.suiteMinutes ?? 'n/a'),
    ],
    ['Reference screenshots', String(metrics.references)],
    [
      'Rendered differently (before filter)',
      `${String(metrics.filter.renderedChanged)} (${pct(metrics.filter.renderedChanged, metrics.references)})`,
    ],
    ['Kept (candidates)', String(metrics.filter.kept)],
    ['Ignored (noise)', String(metrics.filter.ignored)],
    [
      'Held: flapping / contested / out of scope',
      `${String(metrics.filter.flapping)} / ${String(metrics.filter.contested)} / ${String(metrics.filter.outOfScope)}`,
    ],
    [
      'Candidates in focus / other',
      `${String(metrics.focus.kept)} / ${String(metrics.focus.other)}`,
    ],
    [
      'Unique before→after pairs',
      `${String(metrics.pairs.unique)} (${String(metrics.pairs.new)} new)`,
    ],
    ['Filter seconds', String(metrics.filter.seconds ?? 'n/a')],
    [
      'Labels',
      [
        metrics.run.labels.ciFull ? 'ci-full' : '',
        metrics.run.labels.updateScreenshots ? 'update-screenshots' : '',
      ]
        .filter(Boolean)
        .join(', ') || 'none',
    ],
  ]
  return [
    '## Screenshot review metrics',
    '',
    'Untrusted measurement from this run (PR code); see `screenshot-metrics-<run-id>` artifact.',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    ...rows.map(([metric, value]) => `| ${metric} | ${value} |`),
    '',
  ].join('\n')
}

function env(name: string): string {
  return process.env[name]?.trim() ?? ''
}

function intEnv(name: string): number {
  const value = Number(env(name))
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function isoNow(): string {
  return new Date().toISOString()
}

function readIso(path: string): string | null {
  try {
    return ISO.parse(readFileSync(path, 'utf8').trim())
  } catch {
    return null
  }
}

/** `shard-record`: one JSON line describing this shard, from the step env. */
export function shardRecordFromEnv(): ShardRecord {
  return shardRecordSchema.parse({
    shard: intEnv('SHARD'),
    total: intEnv('SHARD_TOTAL'),
    mode: env('PLAN_MODE') || 'unknown',
    jobStartedAt: env('JOB_STARTED_FILE') ? readIso(env('JOB_STARTED_FILE')) : null,
    suiteStartedAt: env('SUITE_STARTED_FILE') ? readIso(env('SUITE_STARTED_FILE')) : null,
    finishedAt: isoNow(),
    runner: {
      environment: env('RUNNER_ENVIRONMENT') || 'unknown',
      name: env('RUNNER_NAME') || 'unknown',
      os: env('RUNNER_OS') || 'unknown',
      arch: env('RUNNER_ARCH') || 'unknown',
    },
    changed: intEnv('CHANGED_COUNT'),
  })
}

/** Shard records from the `.shard-N` markers of a merged candidate tree. */
export function readShardRecords(candidatesDir: string): ShardRecord[] {
  if (!existsSync(candidatesDir)) return []
  const decode = decodeWithSchema(shardRecordSchema)
  const records: ShardRecord[] = []
  for (const entry of readdirSync(candidatesDir).sort()) {
    if (!/^\.shard-[1-8]$/.test(entry)) continue
    const record = safeJsonParse(readFileSync(join(candidatesDir, entry), 'utf8'), decode)
    if (record) records.push(record)
  }
  return records
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

/** The surviving candidate PNGs with their before/after identities. */
export function collectCandidatePairs(candidatesDir: string, focus: Set<string>): CandidatePair[] {
  const directory = join(candidatesDir, SCREENSHOT_DIRECTORY)
  if (!existsSync(directory)) return []
  const manifest = manifestAtRef('HEAD')
  return readdirSync(directory)
    .filter((name) => SCREENSHOT_NAME.test(name))
    .sort()
    .map((name) => ({
      name,
      beforeSha256: manifest?.screenshots[name]?.sha256 ?? null,
      sha256: createHash('sha256')
        .update(readFileSync(join(directory, name)))
        .digest('hex'),
      focus: focus.has(name),
    }))
}

function runMetrics(): void {
  const candidatesDir = env('CANDIDATES_DIR') || 'candidates'
  const out = env('METRICS_OUT') || 'screenshot-metrics.json'
  const base = env('SCREENSHOT_MAIN_REF') || 'origin/main'
  const changedFiles = git(['diff', '--name-only', `${base}...HEAD`])
    .split('\n')
    .filter(Boolean)
  const focus = focusNames(
    changedFiles,
    (path) => git(['cat-file', 'blob', `HEAD:${path}`]) || null,
  )
  const manifest = manifestAtRef('HEAD')
  const prNumber = intEnv('PR_NUMBER')
  const metrics = buildScreenshotMetrics({
    run: {
      id: env('RUN_ID'),
      attempt: intEnv('RUN_ATTEMPT') || 1,
      prNumber: prNumber > 0 ? prNumber : null,
      headSha: env('HEAD_SHA'),
      baseSha: env('BASE_SHA'),
      labels: {
        ciFull: env('CI_FULL_LABEL') === 'true',
        updateScreenshots: env('UPDATE_SCREENSHOTS_LABEL') === 'true',
      },
    },
    references: manifest ? Object.keys(manifest.screenshots).length : 0,
    filter: {
      ran: env('FILTER_RAN') === 'true',
      renderedChanged: intEnv('RENDERED_CHANGED'),
      kept: intEnv('KEPT_COUNT'),
      ignored: intEnv('IGNORED_COUNT'),
      flapping: intEnv('FLAPPING_COUNT'),
      contested: intEnv('CONTESTED_COUNT'),
      outOfScope: intEnv('OUT_OF_SCOPE_COUNT'),
      seconds: env('FILTER_SECONDS') ? intEnv('FILTER_SECONDS') : null,
    },
    shards: readShardRecords(candidatesDir),
    candidates: collectCandidatePairs(candidatesDir, focus),
  })
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(metrics, null, 2)}\n`)
  const summary = process.env['GITHUB_STEP_SUMMARY']
  if (summary) appendFileSync(summary, renderMetricsSummary(metrics))
  console.log(renderMetricsSummary(metrics))
}

if (isDirectExecution(import.meta.url, 'screenshot-metrics')) {
  const command = process.argv[2]
  if (command === 'shard-record') {
    process.stdout.write(`${JSON.stringify(shardRecordFromEnv())}\n`)
  } else if (command === 'run') {
    runMetrics()
  } else {
    throw new Error('Usage: screenshot-metrics.mts <shard-record|run>')
  }
}
