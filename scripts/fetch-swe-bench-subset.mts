// SWE-bench Verified subset adapter (#752 — docs/plans/industry-benchmarks.md,
// Phase 2). Resolves the pinned instance ids in
// benchmarks/swe-bench/verified-subset.ids.json against the dataset via the
// Hugging Face datasets-server rows API and emits one bench:agent task file per
// instance into benchmarks/tasks/swe-bench/ (generated, gitignored):
//
//   - workspace: shallow git checkout of the instance's base_commit
//   - prompt: the instance's problem statement
//   - grading: apply the instance's held-back test patch (the agent never sees
//     it), then run the FAIL_TO_PASS pytest node ids
//
// Run where outbound network is allowed (nightly self-hosted runner, dev
// machine):  node scripts/fetch-swe-bench-subset.mts [--out <dir>]
//
// Fidelity caveat, documented in the plan: grading runs in whatever Python
// environment the runner provides (task.setup pip-installs the checkout),
// not the official per-instance Docker images — good enough for trend lines
// on our own harness, not for leaderboard claims.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BenchTask } from './bench-agent-lib.mts'
import { expectStringArray } from '../src/shared/unknown-value.mts'
import { z } from 'zod'

const DATASET_API =
  'https://datasets-server.huggingface.co/rows?dataset=princeton-nlp%2FSWE-bench_Verified&config=default&split=test'
const PAGE_SIZE = 100
const IDS_PATH = 'benchmarks/swe-bench/verified-subset.ids.json'

interface SweBenchRow {
  instance_id: string
  repo: string
  base_commit: string
  problem_statement: string
  /** JSON-encoded string list of pytest node ids. */
  FAIL_TO_PASS: string
  test_patch: string
}

interface RowsResponse {
  rows: Array<{ row: SweBenchRow }>
  num_rows_total: number
}

const sweBenchRowSchema: z.ZodType<SweBenchRow> = z.object({
  instance_id: z.string(),
  repo: z.string(),
  base_commit: z.string(),
  problem_statement: z.string(),
  FAIL_TO_PASS: z.string(),
  test_patch: z.string(),
})

const rowsResponseSchema: z.ZodType<RowsResponse> = z.object({
  rows: z.array(z.object({ row: sweBenchRowSchema })),
  num_rows_total: z.number(),
})
const pinnedInstancesSchema = z.object({ instances: z.array(z.string()) })

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i !== -1 ? process.argv[i + 1] : undefined
}

async function fetchPage(offset: number): Promise<RowsResponse> {
  const res = await fetch(`${DATASET_API}&offset=${String(offset)}&length=${String(PAGE_SIZE)}`)
  if (!res.ok) {
    throw new Error(`datasets-server ${String(res.status)} at offset ${String(offset)}`)
  }
  return rowsResponseSchema.parse(await res.json())
}

function toTask(row: SweBenchRow): BenchTask {
  const failToPass = expectStringArray(JSON.parse(row.FAIL_TO_PASS) as unknown)
  const testArgs = failToPass.map((t) => `'${t.replace(/'/g, "'\\''")}'`).join(' ')
  return {
    id: row.instance_id,
    description: `SWE-bench Verified instance ${row.instance_id} (${row.repo})`,
    prompt: `Fix the following issue in this repository. Make the minimal change that resolves it; do not modify tests.\n\n${row.problem_statement}`,
    repo: {
      url: `https://github.com/${row.repo}.git`,
      commit: row.base_commit,
    },
    setup: 'python -m pip install -e . --quiet',
    grade: {
      kind: 'shell',
      command: `python -m pytest -rA --no-header ${testArgs}`,
      applyPatch: row.test_patch,
    },
    maxSteps: 40,
    timeoutMs: 30 * 60_000,
  }
}

async function main(): Promise<void> {
  const outDir = argValue('--out') ?? 'benchmarks/tasks/swe-bench'
  const pinned = pinnedInstancesSchema.parse(JSON.parse(readFileSync(IDS_PATH, 'utf8')) as unknown)
  const wanted = new Set(pinned.instances)
  mkdirSync(outDir, { recursive: true })

  const found = new Map<string, SweBenchRow>()
  let offset = 0
  let total = Number.POSITIVE_INFINITY
  while (offset < total && found.size < wanted.size) {
    const page = await fetchPage(offset)
    total = page.num_rows_total
    for (const { row } of page.rows) {
      if (wanted.has(row.instance_id)) found.set(row.instance_id, row)
    }
    offset += PAGE_SIZE
  }

  for (const [id, row] of found) {
    const task = toTask(row)
    writeFileSync(join(outDir, `${id}.json`), `${JSON.stringify(task, null, 2)}\n`, 'utf8')
  }
  console.log(`fetch-swe-bench-subset: wrote ${String(found.size)} task(s) to ${outDir}`)

  const missing = pinned.instances.filter((id) => !found.has(id))
  if (missing.length > 0) {
    console.error(
      `fetch-swe-bench-subset: ${String(missing.length)} pinned id(s) not in SWE-bench Verified — fix ${IDS_PATH}: ${missing.join(', ')}`,
    )
    process.exit(1)
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
