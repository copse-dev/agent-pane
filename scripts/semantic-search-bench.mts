/**
 * Retrieval-quality benchmark for the gortex semantic-search backend.
 *
 * Measures whether the backend actually returns the right code for a natural-
 * language query — recall@k, MRR, and search latency — against a fixed fixture
 * set (`semantic-search-bench.fixtures.json`) whose gold targets are defined by
 * a human, independently of the backend, so the benchmark is not circular.
 *
 * It is deliberately self-contained: it drives the `gortex` CLI directly with
 * its own temp HOME and does its own minimal result-path extraction, so it runs
 * in CI with no Electron/app harness. The CLI arg shapes and JSON fields mirror
 * the production code path in `src/main/services/semantic-index.ts`
 * (searchWithGortex / parseGortexJson) — keep them in sync when the gortex CLI
 * changes. (Structured per-backend so a second backend can be slotted in later.)
 *
 * Usage:
 *   node scripts/semantic-search-bench.mts [--backend gortex|auto]
 *        [--repo <path>] [--k 5] [--json <out.json>]
 *        [--min-recall 0.8] [--max-p95-ms 2500] [--gate]
 *
 * With --gate the process exits non-zero when the primary backend falls below
 * --min-recall or above --max-p95-ms, so CI can use it as a quality gate.
 */
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const FIXTURES_PATH = join(SCRIPT_DIR, 'semantic-search-bench.fixtures.json')

type BackendName = 'gortex'

interface Query {
  id: string
  query: string
  expectedPaths: string[]
}

interface Fixtures {
  queries: Query[]
}

interface QueryResult {
  id: string
  hit: boolean
  rank: number | null
  latencyMs: number
  topPaths: string[]
}

interface BackendReport {
  backend: BackendName
  command: string
  indexMs: number
  recall: number
  mrr: number
  p50Ms: number
  p95Ms: number
  queries: QueryResult[]
}

interface Args {
  backend: 'gortex' | 'auto'
  repo: string
  k: number
  jsonOut: string | null
  minRecall: number
  maxP95Ms: number
  gate: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    backend: 'auto',
    repo: REPO_ROOT,
    k: 5,
    jsonOut: null,
    minRecall: 0.8,
    maxP95Ms: 2500,
    gate: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`missing value for ${String(flag)}`)
      return v
    }
    switch (flag) {
      case '--backend': {
        const v = next()
        if (v !== 'gortex' && v !== 'auto') {
          throw new Error(`--backend must be gortex|auto, got ${v}`)
        }
        args.backend = v
        break
      }
      case '--repo':
        args.repo = resolve(next())
        break
      case '--k':
        args.k = Number(next())
        break
      case '--json':
        args.jsonOut = resolve(next())
        break
      case '--min-recall':
        args.minRecall = Number(next())
        break
      case '--max-p95-ms':
        args.maxP95Ms = Number(next())
        break
      case '--gate':
        args.gate = true
        break
      default:
        throw new Error(`unknown flag: ${String(flag)}`)
    }
  }
  return args
}

async function firstAccessible(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // try next
    }
  }
  return null
}

/** Resolve a backend binary from the vendored copy first, then PATH. */
async function resolveBackend(backend: BackendName): Promise<string | null> {
  const bin = process.platform === 'win32' ? `${backend}.exe` : backend
  const vendored = await firstAccessible([
    join(REPO_ROOT, 'vendor', backend, bin),
    join(REPO_ROOT, 'dist', 'resources', backend, bin),
  ])
  if (vendored) return vendored
  // Fall back to PATH: `gortex version` exits 0 without a daemon.
  try {
    await execFileAsync(bin, ['version'])
    return bin
  } catch {
    return null
  }
}

/** Normalize a returned path to repo-relative POSIX form for gold comparison. */
function toRepoRelative(repo: string, p: string): string {
  const abs = isAbsolute(p) ? p : join(repo, p)
  return relative(repo, abs).split('\\').join('/')
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)] ?? 0
}

// ---- gortex ---------------------------------------------------------------

async function benchGortex(
  cmd: string,
  repo: string,
  home: string,
  k: number,
  queries: Query[],
): Promise<{ indexMs: number; results: QueryResult[] }> {
  const env = { ...process.env, HOME: home, GOMAXPROCS: '4' }
  const run = (args: string[]): Promise<{ stdout: string; stderr: string }> =>
    execFileAsync(cmd, [...args, '--no-progress'], { env, maxBuffer: 64 * 1024 * 1024 })

  // Lifecycle mirrors ensureGortexDaemon + ensureGortexIndex.
  await run(['daemon', 'status']).catch(async () => {
    await run(['daemon', 'start', '--detach']).catch(() => undefined)
  })
  const indexStart = performance.now()
  await run(['track', repo, '--wait', '--wait-timeout', '5m'])
  const indexMs = performance.now() - indexStart

  const results: QueryResult[] = []
  for (const q of queries) {
    const start = performance.now()
    const { stdout } = await run([
      'call',
      'search_symbols',
      '--index',
      repo,
      '--format',
      'json',
      '--json',
      JSON.stringify({ q: q.query, limit: k }),
    ])
    const latencyMs = performance.now() - start
    // parseGortexJson keys on absolute_file_path/file_path.
    const parsed = JSON.parse(stdout) as { results?: Array<Record<string, unknown>> | null }
    const paths = (parsed.results ?? [])
      .map((r) => (r['absolute_file_path'] ?? r['file_path'] ?? r['path']) as string | undefined)
      .filter((p): p is string => typeof p === 'string')
      .slice(0, k)
      .map((p) => toRepoRelative(repo, p))
    results.push(scoreQuery(q, paths, latencyMs))
  }

  await run(['daemon', 'stop']).catch(() => undefined)
  return { indexMs, results }
}

function scoreQuery(q: Query, topPaths: string[], latencyMs: number): QueryResult {
  const gold = new Set(q.expectedPaths)
  let rank: number | null = null
  for (let i = 0; i < topPaths.length; i++) {
    if (gold.has(topPaths[i] ?? '')) {
      rank = i + 1
      break
    }
  }
  return { id: q.id, hit: rank !== null, rank, latencyMs, topPaths }
}

function summarize(
  backend: BackendName,
  command: string,
  indexMs: number,
  results: QueryResult[],
): BackendReport {
  const hits = results.filter((r) => r.hit)
  const recall = results.length ? hits.length / results.length : 0
  const mrr = results.length
    ? results.reduce((acc, r) => acc + (r.rank ? 1 / r.rank : 0), 0) / results.length
    : 0
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b)
  const report: BackendReport = {
    backend,
    command,
    indexMs: Math.round(indexMs),
    recall,
    mrr,
    p50Ms: Math.round(percentile(latencies, 50)),
    p95Ms: Math.round(percentile(latencies, 95)),
    queries: results,
  }
  return report
}

function printReport(report: BackendReport, k: number): void {
  console.log(`\n=== ${report.backend} (${report.command}) ===`)
  console.log(
    `index: ${String(report.indexMs)} ms   search p50/p95: ${String(report.p50Ms)}/${String(
      report.p95Ms,
    )} ms`,
  )
  const hitCount = report.queries.filter((q) => q.hit).length
  console.log(
    `recall@${String(k)}: ${(report.recall * 100).toFixed(1)}%   MRR: ${report.mrr.toFixed(
      3,
    )}   (${String(hitCount)}/${String(report.queries.length)})`,
  )
  for (const q of report.queries) {
    const mark = q.hit ? `✓ rank ${String(q.rank)}` : '✗ miss'
    console.log(
      `  ${q.hit ? '✓' : '✗'} ${q.id.padEnd(28)} ${mark.padEnd(10)} ${q.latencyMs.toFixed(0)}ms`,
    )
    if (!q.hit) console.log(`      top: ${q.topPaths.join(', ') || '(none)'}`)
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8')) as Fixtures

  // Fail loudly on a stale gold target (a file that was moved/renamed) rather
  // than letting it silently count as a miss and quietly erode recall.
  const stale = fixtures.queries.flatMap((q) =>
    q.expectedPaths.filter((p) => !existsSync(join(args.repo, p))).map((p) => `${q.id} -> ${p}`),
  )
  if (stale.length) {
    console.error(`[bench] stale gold target(s) — update the fixture:\n  ${stale.join('\n  ')}`)
    process.exit(2)
  }

  const wanted: BackendName[] = ['gortex']

  const reports: BackendReport[] = []
  for (const backend of wanted) {
    const cmd = await resolveBackend(backend)
    if (!cmd) {
      console.error(`[bench] ${backend} binary not found (vendor/${backend} or PATH)`)
      process.exit(2)
    }
    const home = await mkdtemp(join(tmpdir(), `sem-bench-${backend}-`))
    try {
      await mkdir(home, { recursive: true })
      const { indexMs, results } = await benchGortex(cmd, args.repo, home, args.k, fixtures.queries)
      const report = summarize(backend, cmd, indexMs, results)
      printReport(report, args.k)
      reports.push(report)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }

  if (reports.length === 0) {
    console.error('[bench] no backend available to benchmark')
    process.exit(2)
  }

  if (args.jsonOut) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(args.jsonOut, `${JSON.stringify({ k: args.k, reports }, null, 2)}\n`)
    console.log(`\n[bench] wrote ${args.jsonOut}`)
  }

  if (args.gate) {
    // Gate on the primary (first-run) backend's recall + latency.
    const primary = reports[0]
    if (!primary) process.exit(2)
    const failures: string[] = []
    if (primary.recall < args.minRecall) {
      failures.push(
        `recall@${String(args.k)} ${(primary.recall * 100).toFixed(1)}% < ${(
          args.minRecall * 100
        ).toFixed(0)}% floor`,
      )
    }
    if (primary.p95Ms > args.maxP95Ms) {
      failures.push(`search p95 ${String(primary.p95Ms)}ms > ${String(args.maxP95Ms)}ms ceiling`)
    }
    if (failures.length) {
      console.error(`\n[bench] GATE FAILED for ${primary.backend}: ${failures.join('; ')}`)
      process.exit(1)
    }
    console.log(`\n[bench] GATE PASSED for ${primary.backend}`)
  }
}

main().catch((err: unknown) => {
  console.error('[bench]', err instanceof Error ? err.stack : err)
  process.exit(1)
})
