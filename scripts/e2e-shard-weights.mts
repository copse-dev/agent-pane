/**
 * Refresh `scripts/e2e-shard-weights.json`, the per-spec durations the test
 * oracle's `--ci-shard` uses to balance CI e2e shards (see `assignShards`).
 *
 * Reads recent `e2e (N)` job logs from the CI workflow with `gh`, takes each
 * spec's RUNNING → PASSED interval from the wdio spec reporter, and records the
 * median per spec. Failed and interrupted specs are ignored, so a hang never
 * inflates a weight. Rerun it when shard times drift apart:
 *
 *   node scripts/e2e-shard-weights.mts            # 160 most recent shard logs
 *   node scripts/e2e-shard-weights.mts --jobs 400
 */
import { execFile } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from './lib/safe-json.mts'

const REPO = 'copse-dev/agent-pane'
const OUT = 'scripts/e2e-shard-weights.json'

// `2026-10-03T11:19:07.5582464Z [0-0] PASSED in chrome(…) - file:///tests/e2e/x.e2e.ts`
const REPORTER_LINE =
  /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) .*?\[(\d+-\d+)\] (RUNNING|PASSED|FAILED|SKIPPED) in .* - file:\/\/\/(tests\/e2e\/\S+\.e2e\.ts)/

// GitHub keeps the reporter's colour codes in job logs.
const ANSI_COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

/** Seconds each spec took to pass in one job log, keyed by spec path. */
export function specDurations(log: string): Map<string, number[]> {
  const started = new Map<string, number>()
  const out = new Map<string, number[]>()
  for (const line of log.replaceAll(ANSI_COLOUR, '').split('\n')) {
    const m = REPORTER_LINE.exec(line)
    if (!m?.[1] || !m[2] || !m[4]) continue
    const at = Date.parse(m[1]) / 1000
    if (m[3] === 'RUNNING') started.set(m[2], at)
    else {
      const from = started.get(m[2])
      started.delete(m[2])
      if (m[3] !== 'PASSED' || from === undefined) continue
      out.set(m[4], [...(out.get(m[4]) ?? []), at - from])
    }
  }
  return out
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const hi = sorted[mid] ?? 0
  return sorted.length % 2 === 1 ? hi : ((sorted[mid - 1] ?? hi) + hi) / 2
}

const exec = promisify(execFile)
async function gh(path: string): Promise<string> {
  const { stdout } = await exec('gh', ['api', '--allow-escape-sequences', path], {
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout
}

const runsSchema = z.object({ workflow_runs: z.array(z.object({ id: z.number() })) })
const jobsSchema = z.object({
  jobs: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      steps: z.array(z.object({ name: z.string(), conclusion: z.string().nullable() })).optional(),
    }),
  ),
})

async function recentShardJobs(limit: number): Promise<number[]> {
  const ids: number[] = []
  for (let page = 1; ids.length < limit && page <= 10; page++) {
    const runs = safeJsonParse(
      await gh(`repos/${REPO}/actions/workflows/ci.yml/runs?per_page=50&page=${String(page)}`),
      decodeWithSchema(runsSchema),
    )
    if (!runs || runs.workflow_runs.length === 0) break
    for (const run of runs.workflow_runs) {
      const jobs = safeJsonParse(
        await gh(`repos/${REPO}/actions/runs/${String(run.id)}/jobs?per_page=100`),
        decodeWithSchema(jobsSchema),
      )
      for (const job of jobs?.jobs ?? []) {
        const ran = job.steps?.some(
          (s) =>
            s.name.startsWith('e2e shard') &&
            (s.conclusion === 'success' || s.conclusion === 'failure'),
        )
        if (job.name.startsWith('e2e (') && ran) ids.push(job.id)
      }
      if (ids.length >= limit) break
    }
  }
  return ids.slice(0, limit)
}

async function main(): Promise<void> {
  const flag = process.argv.indexOf('--jobs')
  const limit = flag >= 0 ? Number(process.argv[flag + 1]) : 160
  const jobs = await recentShardJobs(limit)
  const samples = new Map<string, number[]>()
  for (let i = 0; i < jobs.length; i += 16) {
    const logs = await Promise.all(
      jobs.slice(i, i + 16).map((id) => gh(`repos/${REPO}/actions/jobs/${String(id)}/logs`)),
    )
    for (const log of logs)
      for (const [spec, secs] of specDurations(log))
        samples.set(spec, [...(samples.get(spec) ?? []), ...secs])
  }
  const seconds = Object.fromEntries(
    [...samples]
      // Older PR bases still run specs that have since been renamed or removed.
      .filter(([spec]) => existsSync(spec))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([spec, secs]) => [spec, Math.round(median(secs) * 10) / 10]),
  )
  const source = `median PASSED seconds over ${String(jobs.length)} CI e2e shard logs, ${new Date().toISOString().slice(0, 10)}`
  writeFileSync(OUT, `${JSON.stringify({ source, seconds }, null, 2)}\n`)
  console.log(`${OUT}: ${String(Object.keys(seconds).length)} specs (${source})`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
