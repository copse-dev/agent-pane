/**
 * Flake classification over the per-spec, per-attempt e2e outcome records the
 * CI shard writes (`scripts/lib/e2e-outcomes.mts`, schema in gate-evidence.mts).
 *
 * A flake here is a spec that both failed and passed on the same code: inside
 * one workflow run attempt (the shard's outer retry), or across workflow
 * re-runs / runs of the same commit. Pure functions only; the CLI in
 * `scripts/flake-report.mts` does the I/O.
 */
import { outcomeSchema, passedOnRetry, type SpecOutcome } from './gate-evidence.mts'
import { decodeWithSchema, safeJsonParse } from './safe-json.mts'

export type AttemptOutcome = SpecOutcome['outcome']

/**
 * - `retried-pass`: failed, then passed on the shard retry (the absorbed flake).
 * - `interrupted-then-passed`: attempt 1 never finished (the attempt watchdog
 *   killed it mid-spec), then passed on the retry.
 * - `passed-then-failed`: passed on attempt 1, failed when the retry reran it.
 * - `failed` / `passed`: consistent result. `incomplete`: no finished attempt.
 */
export type Verdict =
  | 'retried-pass'
  | 'interrupted-then-passed'
  | 'passed-then-failed'
  | 'failed'
  | 'passed'
  | 'incomplete'

const FLAKY: ReadonlySet<Verdict> = new Set([
  'retried-pass',
  'interrupted-then-passed',
  'passed-then-failed',
])

export function isFlaky(verdict: Verdict): boolean {
  return FLAKY.has(verdict)
}

/** One spec in one workflow run attempt. */
export interface Observation {
  spec: string
  runId: string
  runAttempt: number
  shard: string
  commit: string
  attempt1: AttemptOutcome | null
  attempt2: AttemptOutcome | null
  verdict: Verdict
}

/** Classify the shard attempts of one spec within one workflow run attempt. */
export function classifyAttempts(rows: readonly SpecOutcome[]): Verdict {
  const first = rows.find((row) => row.attempt === 1)?.outcome ?? null
  const second = rows.find((row) => row.attempt === 2)?.outcome ?? null
  if (passedOnRetry(rows)) return 'retried-pass'
  if (first === 'running' && second === 'passed') return 'interrupted-then-passed'
  if (first === 'passed' && second === 'failed') return 'passed-then-failed'
  if (rows.some((row) => row.outcome === 'failed')) return 'failed'
  if (rows.some((row) => row.outcome === 'passed')) return 'passed'
  return 'incomplete'
}

export function observe(outcomes: readonly SpecOutcome[]): Observation[] {
  const groups = new Map<string, SpecOutcome[]>()
  for (const row of outcomes) {
    const key = `${row.runId}\0${row.runAttempt}\0${row.spec}`
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }
  return [...groups.values()].map((rows) => {
    const [head] = rows
    if (!head) throw new Error('Empty outcome group')
    return {
      spec: head.spec,
      runId: head.runId,
      runAttempt: Number(head.runAttempt),
      shard: head.shard,
      commit: head.commit,
      attempt1: rows.find((row) => row.attempt === 1)?.outcome ?? null,
      attempt2: rows.find((row) => row.attempt === 2)?.outcome ?? null,
      verdict: classifyAttempts(rows),
    }
  })
}

/**
 * A finished failure followed, on the same commit, by a pass in a later
 * workflow run attempt or a later run: the fail→pass a manual "Re-run failed
 * jobs" hides. Returned once per spec and commit.
 */
export interface RerunFlip {
  spec: string
  commit: string
  failed: { runId: string; runAttempt: number }
  passed: { runId: string; runAttempt: number }
}

const order = (a: Observation, b: Observation): number =>
  Number(a.runId) - Number(b.runId) || a.runAttempt - b.runAttempt

export function rerunFlips(observations: readonly Observation[]): RerunFlip[] {
  const groups = new Map<string, Observation[]>()
  for (const row of observations) {
    if (row.verdict === 'incomplete') continue
    const key = `${row.spec}\0${row.commit}`
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }
  const flips: RerunFlip[] = []
  for (const rows of groups.values()) {
    const sorted = [...rows].sort(order)
    const failure = sorted.find((row) => row.verdict === 'failed')
    if (!failure) continue
    const pass = sorted.find(
      (row) => order(row, failure) > 0 && row.verdict !== 'failed' && row.verdict !== 'incomplete',
    )
    if (!pass) continue
    flips.push({
      spec: failure.spec,
      commit: failure.commit,
      failed: { runId: failure.runId, runAttempt: failure.runAttempt },
      passed: { runId: pass.runId, runAttempt: pass.runAttempt },
    })
  }
  return flips.sort((a, b) => a.spec.localeCompare(b.spec))
}

export interface SpecStats {
  spec: string
  /** Workflow run attempts with at least one finished attempt of this spec. */
  runsObserved: number
  /** Attempt 1 failed, or was cut off by the watchdog before the retry ran. */
  attempt1Failures: number
  /** Failed (or was interrupted) on attempt 1 and passed on the shard retry. */
  retriedPasses: number
  passedThenFailed: number
  /** Same-commit fail→pass across workflow re-runs or runs. */
  rerunFlips: number
  /** Run attempts whose last shard attempt still failed. */
  finalFailures: number
  /** Flaky events (retried passes, pass→fail, re-run flips) per run observed. */
  flakeRate: number
  /** `runId/runAttempt` of each flaky or finally failing observation, oldest first. */
  runs: string[]
}

export function aggregate(observations: readonly Observation[]): SpecStats[] {
  const flips = rerunFlips(observations)
  const specs = [...new Set(observations.map((row) => row.spec))]
  return specs
    .map((spec) => {
      const rows = observations.filter((row) => row.spec === spec && row.verdict !== 'incomplete')
      const retriedPasses = rows.filter(
        (row) => row.verdict === 'retried-pass' || row.verdict === 'interrupted-then-passed',
      ).length
      const passedThenFailed = rows.filter((row) => row.verdict === 'passed-then-failed').length
      const flipCount = flips.filter((flip) => flip.spec === spec).length
      const runsObserved = rows.length
      return {
        spec,
        runsObserved,
        attempt1Failures: rows.filter(
          (row) =>
            row.attempt1 === 'failed' || (row.attempt1 === 'running' && row.attempt2 !== null),
        ).length,
        retriedPasses,
        passedThenFailed,
        rerunFlips: flipCount,
        // From the verdict, not `attempt2 ?? attempt1`: an attempt 2 the watchdog killed is still
        // `running`, and that must not hide a recorded attempt-1 failure.
        finalFailures: rows.filter(
          (row) => row.verdict === 'failed' || row.verdict === 'passed-then-failed',
        ).length,
        flakeRate: runsObserved ? (retriedPasses + passedThenFailed + flipCount) / runsObserved : 0,
        runs: rows
          .filter((row) => isFlaky(row.verdict) || row.verdict === 'failed')
          .sort(order)
          .map((row) => `${row.runId}/${String(row.runAttempt)}`),
      }
    })
    .sort(
      (a, b) =>
        b.flakeRate - a.flakeRate ||
        b.attempt1Failures - a.attempt1Failures ||
        a.spec.localeCompare(b.spec),
    )
}

/** Parse one evidence file; null for anything that is not an outcome record. */
export function parseOutcomeRecord(text: string): SpecOutcome | null {
  return safeJsonParse(text, decodeWithSchema(outcomeSchema))
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /
const PREFIXED = /^(\[[^\]]+\])(?: (.*))?$/

export interface FailureDetail {
  titles: string[]
  digest: string[]
}

/**
 * Failed test titles and the first error lines for `spec`, read from a raw
 * wdio spec-reporter log (the shard's tee'd `attempt-N.log`; GitHub job-log
 * timestamps are tolerated). Selects by worker prefix, as the shard digest
 * does, so header, verdict and error arrive together.
 */
export function extractFailureDetail(log: string, spec: string, maxDigest = 6): FailureDetail {
  const lines = log.split(/\r?\n/).map((line) => line.replace(TIMESTAMP, ''))
  const workers = new Set<string>()
  for (const line of lines) {
    const match = PREFIXED.exec(line)
    const body = match?.[2]?.trim()
    if (match?.[1] && body?.startsWith('» ') && body.replace(/^» \/?/, '') === spec)
      workers.add(match[1])
  }
  const titles: string[] = []
  const digest: string[] = []
  for (const worker of workers) {
    let inFailures = false
    for (const line of lines) {
      const match = PREFIXED.exec(line)
      if (match?.[1] !== worker) continue
      const body = (match[2] ?? '').trim()
      const title = /^✖ (.+)$/.exec(body)?.[1]
      if (title && !titles.includes(title)) titles.push(title)
      if (/^\d+ failing\b/.test(body)) {
        inFailures = true
        continue
      }
      if (!inFailures || !body || digest.length >= maxDigest) continue
      const cleaned = body
        .replace(/file:\/\/\S+ \d+:\d+ /g, '')
        .replace(/Error invoking remote method '[^']+': /g, '')
        .slice(0, 300)
      if (!digest.includes(cleaned)) digest.push(cleaned)
    }
  }
  return { titles, digest }
}

/** GitHub workflow-command escaping (actions/toolkit `escapeData` / `escapeProperty`). */
export function escapeCommandData(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}
export function escapeCommandProperty(value: string): string {
  return escapeCommandData(value).replaceAll(':', '%3A').replaceAll(',', '%2C')
}

/** Markdown table cell: one line, no pipes, no HTML. */
export function cell(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '\\|')
    .trim()
}

export interface ShardFlake {
  observation: Observation
  detail: FailureDetail
}

const verdictText: Record<Verdict, string> = {
  'retried-pass': 'failed attempt 1, passed on the shard retry',
  'interrupted-then-passed': 'attempt 1 was cut off mid-spec, passed on the shard retry',
  'passed-then-failed': 'passed attempt 1, failed when the retry reran it',
  failed: 'failed',
  passed: 'passed',
  incomplete: 'incomplete',
}

export function describeVerdict(verdict: Verdict): string {
  return verdictText[verdict]
}

export function shardAnnotations(flakes: readonly ShardFlake[]): string[] {
  return flakes.map(({ observation, detail }) => {
    const parts = [
      `${observation.spec} ${verdictText[observation.verdict]} (shard ${observation.shard}).`,
    ]
    if (detail.titles.length) parts.push(`Tests: ${detail.titles.join('; ')}.`)
    if (detail.digest[0]) parts.push(`Attempt-1 error: ${detail.digest[0]}`)
    return `::warning file=${escapeCommandProperty(observation.spec)},title=${escapeCommandProperty(
      `Flaky e2e spec (shard ${observation.shard})`,
    )}::${escapeCommandData(parts.join(' '))}`
  })
}

export function shardSummary(shard: string, flakes: readonly ShardFlake[]): string {
  if (!flakes.length) return ''
  const rows = flakes.map(
    ({ observation, detail }) =>
      `| \`${observation.spec}\` | ${cell(observation.verdict)} | ${cell(detail.titles.join('; ') || '—')} | ${cell(detail.digest.join(' ⏎ ') || '(no per-spec failure in the attempt-1 log)')} |`,
  )
  return [
    `### Flaky e2e specs in shard ${shard}`,
    '',
    `${String(flakes.length)} spec(s) did not give the same result on both shard attempts. The shard retry hid this from the job status. See [where flake data lives](https://github.com/copse-dev/agent-pane/blob/main/docs/testing-strategy.md#flake-visibility).`,
    '',
    '| Spec | Verdict | Failed tests | Attempt-1 failure digest |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n')
}

export interface ReportContext {
  title: string
  runs: number
  note?: string
}

const percent = (value: number): string => `${(value * 100).toFixed(0)}%`

export function historySummary(
  context: ReportContext,
  stats: readonly SpecStats[],
  flips: readonly RerunFlip[],
): string {
  const flaky = stats.filter(
    (row) => row.retriedPasses + row.passedThenFailed + row.rerunFlips > 0 || row.finalFailures > 0,
  )
  const lines = [
    `## ${context.title}`,
    '',
    `${String(context.runs)} workflow run attempt(s), ${String(stats.length)} spec(s) observed. ${String(stats.filter((row) => row.flakeRate > 0).length)} spec(s) were flaky and ${String(stats.filter((row) => row.finalFailures > 0).length)} had a final failure.`,
  ]
  if (context.note) lines.push('', context.note)
  if (!flaky.length) {
    lines.push('', 'No spec failed on any attempt.')
    return lines.join('\n') + '\n'
  }
  lines.push(
    '',
    '| Spec | Runs observed | Attempt-1 failures | Retried passes | Pass→fail on retry | Re-run flips | Final failures | Flake rate | Runs (id/attempt) |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...flaky.map(
      (row) =>
        `| \`${row.spec}\` | ${String(row.runsObserved)} | ${String(row.attempt1Failures)} | ${String(row.retriedPasses)} | ${String(row.passedThenFailed)} | ${String(row.rerunFlips)} | ${String(row.finalFailures)} | ${percent(row.flakeRate)} | ${row.runs.slice(-5).join(', ') || '—'} |`,
    ),
  )
  if (flips.length)
    lines.push(
      '',
      'Same-commit fail→pass across workflow re-runs or runs:',
      '',
      ...flips.map(
        (flip) =>
          `- \`${flip.spec}\` at ${flip.commit.slice(0, 12)}: failed in run ${flip.failed.runId} attempt ${String(flip.failed.runAttempt)}, passed in run ${flip.passed.runId} attempt ${String(flip.passed.runAttempt)}`,
      ),
    )
  return lines.join('\n') + '\n'
}

/** Plain-text table for a terminal. */
export function historyText(all: readonly SpecStats[]): string {
  // Only specs with any failure: a 500-row table of zeros buries the signal.
  const stats = all.filter((row) => row.attempt1Failures + row.finalFailures + row.rerunFlips > 0)
  if (!stats.length) return `No failures across ${String(all.length)} spec(s).\n`
  const header = ['spec', 'runs', 'a1-fail', 'retried', 'pass→fail', 'flips', 'final-fail', 'rate']
  const rows = stats.map((row) => [
    row.spec,
    String(row.runsObserved),
    String(row.attempt1Failures),
    String(row.retriedPasses),
    String(row.passedThenFailed),
    String(row.rerunFlips),
    String(row.finalFailures),
    percent(row.flakeRate),
  ])
  const widths = header.map((_, index) =>
    Math.max(...[header, ...rows].map((row) => (row[index] ?? '').length)),
  )
  return (
    [header, ...rows]
      .map((row) => row.map((value, index) => value.padEnd(widths[index] ?? 0)).join('  '))
      .join('\n') + '\n'
  )
}
