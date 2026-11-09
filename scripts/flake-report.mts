/**
 * E2E flake visibility (docs/testing-strategy.md#flake-visibility).
 *
 *   node scripts/flake-report.mts shard <outcomes-dir> [--log attempt-1.log] [--shard N]
 *     In an e2e shard job, after the attempt loop: one ::warning:: and one
 *     job-summary row per spec whose two shard attempts disagreed.
 *   node scripts/flake-report.mts aggregate <dir> [--title T] [--annotate]
 *     Per-spec flake table over every outcome record under <dir> (all shards of
 *     one run, or many runs downloaded by `collect`).
 *   node scripts/flake-report.mts collect <dir> [--runs 30] [--events schedule,merge_group,pull_request]
 *     Download e2e-evidence-shard-* artifacts of the newest completed CI runs
 *     (up to --runs per event) with `gh` (read-only; needs actions:read).
 *
 * Outcome files are data: decoded with the outcome schema, never executed.
 * Advisory: every mode exits 0 unless its arguments are wrong, so it can
 * never turn a test result red.
 */
import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import type { SpecOutcome } from './lib/gate-evidence.mts'
import {
  aggregate,
  extractFailureDetail,
  historySummary,
  historyText,
  isFlaky,
  observe,
  parseOutcomeRecord,
  rerunFlips,
  shardAnnotations,
  shardSummary,
  escapeCommandData,
  escapeCommandProperty,
  describeVerdict,
} from './lib/flake-report.mts'
import { decodeWithSchema, safeJsonParse } from './lib/safe-json.mts'

const MAX_FILE_BYTES = 2_000_000
const MAX_FILES = 50_000
const NOT_OUTCOMES = new Set(['manifest.json', 'plan.json', 'selected-plan.json'])

interface Loaded {
  outcomes: SpecOutcome[]
  rejected: number
}

/** Read every outcome record under `directory`; symlinks and oversized files are skipped. */
function loadOutcomes(directory: string): Loaded {
  const outcomes: SpecOutcome[] = []
  let rejected = 0
  let seen = 0
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) {
        rejected++
        continue
      }
      if (stat.isDirectory()) {
        walk(path)
        continue
      }
      // Collection manifests and the CI gate plan travel beside the outcomes.
      if (!name.endsWith('.json') || NOT_OUTCOMES.has(name)) continue
      if (++seen > MAX_FILES) throw new Error(`More than ${String(MAX_FILES)} evidence files`)
      const record =
        stat.size <= MAX_FILE_BYTES ? parseOutcomeRecord(readFileSync(path, 'utf8')) : null
      if (record) outcomes.push(record)
      else rejected++
    }
  }
  if (existsSync(directory)) walk(directory)
  return { outcomes, rejected }
}

function writeSummary(markdown: string): void {
  const target = process.env['GITHUB_STEP_SUMMARY']
  if (!markdown) return
  if (target) appendFileSync(target, markdown + '\n')
  else process.stdout.write(markdown + '\n')
}

function shard(directory: string, log: string | undefined, shardIndex: string | undefined): void {
  const { outcomes, rejected } = loadOutcomes(directory)
  const text = log && existsSync(log) ? readFileSync(log, 'utf8') : ''
  const flakes = observe(outcomes)
    .filter((row) => isFlaky(row.verdict))
    .sort((a, b) => a.spec.localeCompare(b.spec))
    .map((observation) => ({
      observation,
      // Attempt-1 detail for a first-attempt failure; attempt 2 holds the
      // failure when the spec passed first and failed on the retry.
      detail: extractFailureDetail(
        observation.verdict === 'passed-then-failed' && log
          ? readIfExists(log.replace(/attempt-1\.log$/, 'attempt-2.log'))
          : text,
        observation.spec,
      ),
    }))
  for (const line of shardAnnotations(flakes)) console.log(line)
  writeSummary(shardSummary(shardIndex ?? flakes[0]?.observation.shard ?? '?', flakes))
  console.log(
    `flake-report: ${String(outcomes.length)} outcome record(s), ${String(flakes.length)} flaky spec(s)${rejected ? `, ${String(rejected)} unreadable file(s) skipped` : ''}`,
  )
}

function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function report(directory: string, title: string, annotate: boolean): void {
  const { outcomes, rejected } = loadOutcomes(directory)
  const observations = observe(outcomes)
  const stats = aggregate(observations)
  const flips = rerunFlips(observations)
  const runs = new Set(observations.map((row) => `${row.runId}/${String(row.runAttempt)}`)).size
  const manifest = join(directory, 'manifest.json')
  const note = [
    existsSync(manifest) ? readManifestNote(manifest) : '',
    rejected ? `${String(rejected)} file(s) were not outcome records and were skipped.` : '',
  ]
    .filter(Boolean)
    .join(' ')
  writeSummary(historySummary({ title, runs, note }, stats, flips))
  if (annotate)
    for (const row of observations.filter((item) => isFlaky(item.verdict)))
      console.log(
        `::warning file=${escapeCommandProperty(row.spec)},title=${escapeCommandProperty(`Flaky e2e spec (shard ${row.shard})`)}::${escapeCommandData(`${row.spec} ${describeVerdict(row.verdict)} (run ${row.runId} attempt ${String(row.runAttempt)}, shard ${row.shard}).`)}`,
      )
  if (annotate)
    for (const flip of flips)
      console.log(
        `::warning file=${escapeCommandProperty(flip.spec)},title=${escapeCommandProperty('Flaky e2e spec (re-run)')}::${escapeCommandData(`${flip.spec} failed in run ${flip.failed.runId} attempt ${String(flip.failed.runAttempt)} and passed in run ${flip.passed.runId} attempt ${String(flip.passed.runAttempt)} on the same commit ${flip.commit.slice(0, 12)}.`)}`,
      )
  if (process.env['GITHUB_STEP_SUMMARY']) process.stdout.write(historyText(stats))
}

const manifestSchema = z.array(
  z.object({
    runId: z.string(),
    runAttempt: z.number(),
    event: z.string(),
    head: z.string(),
    createdAt: z.string(),
    artifacts: z.number(),
    missingReason: z.string().optional(),
  }),
)

function readManifestNote(path: string): string {
  const manifest = safeJsonParse(readFileSync(path, 'utf8'), decodeWithSchema(manifestSchema))
  if (!manifest) return ''
  const events = [...new Set(manifest.map((row) => row.event))].join(', ')
  const missing = manifest.filter((row) => row.missingReason).length
  const dates = manifest.map((row) => row.createdAt).sort()
  return `Collected ${String(manifest.length)} completed CI run(s) (${events}) from ${dates[0]?.slice(0, 10) ?? '?'} to ${dates.at(-1)?.slice(0, 10) ?? '?'}; ${String(missing)} had no e2e evidence (e2e skipped or artifacts expired; the repository caps artifact retention).`
}

const runSchema = z.object({
  id: z.number().int(),
  run_attempt: z.number().int(),
  event: z.string(),
  head_sha: z.string(),
  head_branch: z.string().nullable(),
  created_at: z.string(),
})
const runsSchema = z.object({ workflow_runs: z.array(runSchema) })
const artifactsSchema = z.object({
  artifacts: z.array(z.object({ id: z.number().int(), name: z.string(), expired: z.boolean() })),
})

function collect(directory: string, limit: number, events: string[]): void {
  const repository = process.env['GITHUB_REPOSITORY'] ?? 'copse-dev/agent-pane'
  const gh = (path: string): Buffer =>
    execFileSync('gh', ['api', path], { maxBuffer: 50_000_000, timeout: 120_000 })
  if (existsSync(join(directory, 'manifest.json')))
    throw new Error('Choose a fresh directory; it already holds a collection')
  mkdirSync(directory, { recursive: true })
  const runs: z.infer<typeof runSchema>[] = []
  for (const event of events) {
    const response = safeJsonParse(
      gh(
        `repos/${repository}/actions/workflows/ci.yml/runs?event=${encodeURIComponent(event)}&status=completed&per_page=${String(limit)}`,
      ).toString('utf8'),
      decodeWithSchema(runsSchema),
    )
    if (!response) throw new Error(`Invalid workflow runs for ${event}`)
    runs.push(...response.workflow_runs)
  }
  // `limit` applies per event so busy PR traffic cannot crowd out the nightly.
  runs.sort((a, b) => b.created_at.localeCompare(a.created_at))
  const manifest: z.infer<typeof manifestSchema> = []
  for (const run of runs) {
    const entry: z.infer<typeof manifestSchema>[number] = {
      runId: String(run.id),
      runAttempt: run.run_attempt,
      event: run.event,
      head: run.head_sha,
      createdAt: run.created_at,
      artifacts: 0,
    }
    try {
      const listing = safeJsonParse(
        gh(`repos/${repository}/actions/runs/${String(run.id)}/artifacts?per_page=100`).toString(
          'utf8',
        ),
        decodeWithSchema(artifactsSchema),
      )
      if (!listing) throw new Error('Invalid artifact listing')
      const evidence = listing.artifacts.filter((item) =>
        /^e2e-evidence-shard-\d+-\d+$/.test(item.name),
      )
      const live = evidence.filter((item) => !item.expired)
      for (const artifact of live) {
        const target = join(directory, String(run.id), artifact.name)
        mkdirSync(target, { recursive: true })
        const zip = join(target, 'artifact.zip')
        writeFileSync(zip, gh(`repos/${repository}/actions/artifacts/${String(artifact.id)}/zip`))
        // -j flattens paths, so an archive entry cannot escape the target.
        execFileSync('unzip', ['-q', '-o', '-j', zip, '*.json', '-d', target], {
          timeout: 60_000,
        })
        rmSync(zip)
      }
      entry.artifacts = live.length
      if (!evidence.length) entry.missingReason = 'no e2e evidence (e2e did not run)'
      else if (!live.length) entry.missingReason = 'e2e evidence artifacts expired'
    } catch (error) {
      entry.missingReason = error instanceof Error ? error.message : String(error)
    }
    manifest.push(entry)
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  }
  console.log(
    `Collected ${String(manifest.length)} run(s); ${String(manifest.filter((row) => row.artifacts > 0).length)} with e2e evidence. Manifest: ${join(directory, 'manifest.json')}`,
  )
}

const usage =
  'Usage: node scripts/flake-report.mts shard <outcomes-dir> [--log FILE] [--shard N] | aggregate <dir> [--title T] [--annotate] | collect <dir> [--runs N] [--events a,b]'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    log: { type: 'string' },
    shard: { type: 'string' },
    title: { type: 'string' },
    annotate: { type: 'boolean' },
    runs: { type: 'string' },
    events: { type: 'string' },
  },
})
const [mode, directory] = positionals
if (!directory) throw new Error(usage)
if (mode === 'shard') shard(directory, values.log, values.shard)
else if (mode === 'aggregate')
  report(directory, values.title ?? 'E2E flake report', values.annotate ?? false)
else if (mode === 'collect') {
  const limit = Number(values.runs ?? '30')
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error(usage)
  const events = (values.events ?? 'schedule,merge_group,pull_request')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (!events.every((value) => /^[a-z_]+$/.test(value))) throw new Error(usage)
  collect(directory, limit, events)
} else throw new Error(usage)
