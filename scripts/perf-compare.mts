/**
 * Electron vs Tauri+Servo: the measurement harness for
 * docs/plans/tauri-servo-perf-handoff.md.
 *
 * Both stacks run the same renderer bundle and the same main-process source, so
 * the marks in the NDJSON trace (`COPSE_PERF=1`) come from *identical* renderer
 * code on both sides — `renderer:boot-start`, `renderer:layout-mounted` and the
 * rest are directly comparable. This script boots each stack repeatedly on a
 * fresh profile, samples its whole process tree while it idles, and reports the
 * median and spread per metric.
 *
 * Deliberately portable: it samples with `ps`, not `/proc`, so the same numbers
 * can be collected on the macOS dev machine and the Linux box the handoff
 * targets. Absolute values from different machines are not comparable — but the
 * Electron/Servo *ratio* on one machine is the figure the migration decision
 * actually turns on, and that survives the move.
 *
 *   node scripts/perf-compare.mts --runs 5 --stacks electron,tauri
 *
 * Writes per-run traces plus `results.json` and `results.md` under
 * `docs/plans/perf-data/` (override with `--out`).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  lstatSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const RUNS = Number(flag('runs', '5'))
/**
 * Discarded runs before the measured ones. The first launch of either stack
 * pays cold page cache for a large binary — 240 MB for the Servo shell, the
 * Electron framework for the other — and lands 400–500 ms above every
 * subsequent run. Keeping it would not move the median but would widen the
 * reported spread by more than the gap between the stacks.
 */
const WARMUP = Number(flag('warmup', '1'))
const OUT_DIR = resolve(flag('out', 'docs/plans/perf-data'))
/** Seconds to hold each stack open after boot before reading idle cost. */
const IDLE_SECONDS = Number(flag('idle-seconds', '30'))
/** A boot that has not reached `renderer:layout-mounted` by now is a failure. */
const BOOT_TIMEOUT_MS = Number(flag('boot-timeout-ms', '180000'))
const WANTED = flag('stacks', 'electron,tauri').split(',')

// ---------------------------------------------------------------------------
// Stacks
// ---------------------------------------------------------------------------

interface Stack {
  key: string
  label: string
  command: string
  args: string[]
  /** Stack-specific environment, merged over the shared perf/profile knobs. */
  env: Record<string, string>
  /** null when runnable here; otherwise why not, for an honest partial report. */
  unavailable: () => string | null
  /** What ships, for the disk-footprint metric. */
  footprint: () => string[]
}

const ELECTRON_BIN = resolve('node_modules/.bin/electron')
const TAURI_BIN = resolve('tauri-shell/target/release/copse-tauri-shell')

const STACKS: Stack[] = [
  {
    key: 'electron',
    label: `Electron ${electronVersion()}`,
    command: ELECTRON_BIN,
    // Chromium's setuid sandbox cannot initialise as root in a container; the
    // app's own project sandbox is unaffected. Harmless on a normal desktop.
    args: [resolve('dist/main/index.js'), ...(isRoot() ? ['--no-sandbox'] : [])],
    env: {},
    unavailable: () =>
      !existsSync(ELECTRON_BIN)
        ? 'node_modules/.bin/electron missing — run pnpm install'
        : !existsSync(resolve('dist/main/index.js'))
          ? 'dist/main/index.js missing — run pnpm build'
          : null,
    // `node_modules/electron/dist` is a symlink into a shared runtime cache
    // that holds *two* copies of the same runtime — `Electron.app` and the
    // `Copse.app` rename the app-name branding produces. Counting the
    // directory counts both, and a shipped app has one, so name the bundle.
    footprint: () => [electronRuntimeApp(), resolve('dist/main'), resolve('dist/renderer')],
  },
  {
    key: 'tauri',
    label: 'Tauri + Servo (release)',
    command: TAURI_BIN,
    args: [],
    // The sidecar only speaks the stdout line protocol when it knows a shell is
    // listening; without this it logs window ops to stderr and opens nothing.
    env: { COPSE_TAURI_SHELL: '1' },
    unavailable: () =>
      !existsSync(TAURI_BIN)
        ? `${TAURI_BIN} missing — build it with \`cargo build --release\` in tauri-shell/ (see docs/plans/tauri-servo-perf-handoff.md §2)`
        : !existsSync(resolve('dist/sidecar/index.js'))
          ? 'dist/sidecar/index.js missing — run pnpm build:tauri'
          : null,
    // The Rust binary embeds dist/renderer at compile time, so unlike the
    // Electron column the renderer is already counted inside the binary.
    footprint: () => [TAURI_BIN, resolve('dist/sidecar')],
  },
]

/** The single Electron.app inside the runtime cache, resolved through the symlink. */
function electronRuntimeApp(): string {
  try {
    const root = realpathSync(resolve('node_modules/electron/dist'))
    const app = join(root, 'Electron.app')
    return existsSync(app) ? app : root
  } catch {
    return resolve('node_modules/electron/dist')
  }
}

function electronVersion(): string {
  try {
    return readFileSync('node_modules/electron/dist/version', 'utf8').trim()
  } catch {
    return 'unknown'
  }
}

function isRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0
}

// ---------------------------------------------------------------------------
// Process-tree sampling
// ---------------------------------------------------------------------------

interface ProcRow {
  pid: number
  ppid: number
  rssKb: number
  cpuSeconds: number
}

/**
 * `ps` reports cumulative CPU time as `MM:SS.ss`, `HH:MM:SS` or (Linux, long
 * runs) `DD-HH:MM:SS`. Only the last field is fractional.
 */
function parseCpuTime(text: string): number {
  const [days, rest] = text.includes('-') ? text.split('-') : ['0', text]
  const parts = (rest ?? '').split(':').map(Number)
  let seconds = Number(days) * 86_400
  for (const part of parts) seconds = seconds * 60 + (Number.isFinite(part) ? part : 0)
  return seconds
}

function snapshot(): ProcRow[] {
  const raw = execFileSync('ps', ['-Ao', 'pid=,ppid=,rss=,time='], { encoding: 'utf8' })
  const rows: ProcRow[] = []
  for (const line of raw.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 4) continue
    const [pid, ppid, rss, time] = fields
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      rssKb: Number(rss),
      cpuSeconds: parseCpuTime(time ?? '0'),
    })
  }
  return rows
}

interface TreeSample {
  rssKb: number
  cpuSeconds: number
  processes: number
  pids: number[]
}

/**
 * Memory for one process that does not double-count pages shared with its
 * siblings — the thing summed RSS gets wrong, and gets wrong worse the more
 * processes a stack has. Electron idles at five processes sharing one ~200 MB
 * framework binary against the Servo stack's two, so summed RSS overstates
 * Electron by roughly the framework size times the number of helpers, and a
 * naive reading hands Servo a win it has not earned.
 *
 * macOS: `phys_footprint`, the ledger figure Activity Monitor calls "Memory";
 * clean file-backed pages (the mapped framework) are not charged per process.
 * Linux: `Pss` from `smaps_rollup`, which divides each shared page by the
 * number of mappers. Returns null where neither is available, and the caller
 * falls back to RSS with the caveat that implies.
 */
function processMemoryKb(pid: number): number | null {
  try {
    if (process.platform === 'darwin') {
      const raw = execFileSync('footprint', ['-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const match = /phys_footprint:\s*([\d.]+)\s*(KB|MB|GB)/i.exec(raw)
      if (!match) return null
      const value = Number(match[1])
      const unit = (match[2] ?? 'KB').toUpperCase()
      return unit === 'GB' ? value * 1_048_576 : unit === 'MB' ? value * 1024 : value
    }
    if (process.platform === 'linux') {
      const raw = readFileSync(`/proc/${String(pid)}/smaps_rollup`, 'utf8')
      const match = /^Pss:\s*(\d+)\s*kB/m.exec(raw)
      return match ? Number(match[1]) : null
    }
  } catch {
    // The process exited between the tree walk and the query, or the tool is
    // unavailable. Either way: no number, fall back to RSS.
  }
  return null
}

/** Sum over a tree, or null if any member could not be measured. */
function treeMemoryMb(pids: number[]): number | null {
  let total = 0
  for (const pid of pids) {
    const kb = processMemoryKb(pid)
    if (kb === null) return null
    total += kb
  }
  return Math.round(total / 1024)
}

/**
 * Sum over the root and every descendant. Both stacks put their whole cost in
 * one tree — Electron's gpu/utility/renderer helpers, and the shell plus the
 * Node sidecar it spawns — so this is the like-for-like total.
 */
function sampleTree(rootPid: number, rows: ProcRow[]): TreeSample {
  const children = new Map<number, number[]>()
  for (const row of rows) {
    const list = children.get(row.ppid)
    if (list) list.push(row.pid)
    else children.set(row.ppid, [row.pid])
  }
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const stack = [rootPid]
  const seen = new Set<number>()
  let rssKb = 0
  let cpuSeconds = 0
  const pids: number[] = []
  while (stack.length > 0) {
    const pid = stack.pop()
    if (pid === undefined || seen.has(pid)) continue
    seen.add(pid)
    const row = byPid.get(pid)
    if (row) {
      rssKb += row.rssKb
      cpuSeconds += row.cpuSeconds
      pids.push(pid)
    }
    stack.push(...(children.get(pid) ?? []))
  }
  return { rssKb, cpuSeconds, processes: pids.length, pids }
}

// ---------------------------------------------------------------------------
// Trace reading
// ---------------------------------------------------------------------------

interface TraceRecord {
  t: number
  kind: string
  src: string
  name: string
  ms?: number
}

function readTrace(path: string): TraceRecord[] {
  if (!existsSync(path)) return []
  const out: TraceRecord[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      // Our own writer, one JSON object per line; a torn final line is normal
      // if the process was killed mid-flush, hence the try.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      out.push(JSON.parse(line) as TraceRecord)
    } catch {
      continue
    }
  }
  return out
}

function markAt(trace: TraceRecord[], name: string): number | null {
  return trace.find((record) => record.name === name && record.kind === 'mark')?.t ?? null
}

function spanMs(trace: TraceRecord[], name: string): number | null {
  return trace.find((record) => record.name === name && record.kind === 'span')?.ms ?? null
}

/**
 * When a span *closed*, on the trace's shared axis. Sub-millisecond where the
 * wall clock is quantised to the poll interval — but it starts at the moment
 * main armed the tracer, so it excludes the runtime startup that precedes
 * main's first line of JS (larger for Electron than for plain Node). The two
 * figures bracket the truth; report both.
 */
function spanEndAt(trace: TraceRecord[], name: string): number | null {
  return trace.find((record) => record.name === name && record.kind === 'span')?.t ?? null
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

interface RunResult {
  stack: string
  run: number
  ok: boolean
  note?: string
  /** Trace-relative milliseconds; the same axis on both stacks. */
  mainBootCompleteMs: number | null
  rendererBootStartMs: number | null
  rendererLayoutMountedMs: number | null
  rendererBootSpanMs: number | null
  /** Harness wall clock, spawn → the `renderer:boot` span appearing on disk. */
  wallToBootedMs: number | null
  /** Same event on the trace axis: precise, but starts at main's arm. */
  traceToBootedMs: number | null
  /** phys_footprint (macOS) / PSS (Linux); null when neither was available. */
  idleMemoryMb: number | null
  idleRssMb: number | null
  idleCpuPercent: number | null
  processes: number | null
}

async function runOnce(stack: Stack, run: number, runDir: string): Promise<RunResult> {
  mkdirSync(runDir, { recursive: true })
  const profile = mkdtempSync(join(tmpdir(), `copse-perf-${stack.key}-`))
  mkdirSync(join(profile, 'home'), { recursive: true })
  const tracePath = join(runDir, 'trace.ndjson')

  const base: RunResult = {
    stack: stack.key,
    run,
    ok: false,
    mainBootCompleteMs: null,
    rendererBootStartMs: null,
    rendererLayoutMountedMs: null,
    rendererBootSpanMs: null,
    wallToBootedMs: null,
    traceToBootedMs: null,
    idleMemoryMb: null,
    idleRssMb: null,
    idleCpuPercent: null,
    processes: null,
  }

  const spawnedAt = Date.now()
  const child: ChildProcess = spawn(stack.command, stack.args, {
    env: {
      ...process.env,
      COPSE_PERF: '1',
      COPSE_PERF_OUT: tracePath,
      // Fresh and isolated: a cold start that reuses a warmed profile is not a
      // cold start, and neither stack may touch the developer's real data.
      COPSE_DIR: join(profile, 'copse-home'),
      COPSE_PANEL_USER_DATA: join(profile, 'user-data'),
      // `COPSE_DIR` does not cover everything the app reads from the home
      // directory: MCP servers come from `~/.cursor/mcp.json` and skills from
      // `~/.cursor/plugins`. On this machine that pulled a `uv` + Python MCP
      // server — ~98 MB — into *both* process trees, which is neither stack's
      // cost and makes the ratio between them look closer than it is. It also
      // made the numbers depend on whoever's laptop ran them.
      HOME: join(profile, 'home'),
      // Offline, deterministic model responses — no network in the numbers.
      COPSE_PANEL_MOCK_LLM: '1',
      ...stack.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group, so cleanup can kill the *tree*. Electron's helpers
    // survive a SIGKILL aimed at the main process alone; they then both skew
    // the next run's tree sample and hold this harness's stdio pipes open, so
    // the script itself never exits.
    detached: true,
  })
  let log = ''
  child.stdout?.on('data', (chunk: Buffer) => (log += chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => (log += chunk.toString()))

  const cleanup = (): void => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
    } catch {
      // Already gone, or never started — either way there is nothing to reap.
    }
    child.kill('SIGKILL')
    rmSync(profile, { recursive: true, force: true })
    writeFileSync(join(runDir, 'process.log'), log)
  }

  // Boot: poll the trace rather than the process, because "booted" is a renderer
  // fact and the renderer is the only layer that can report it.
  //
  // The signal is the `renderer:boot` span, not `renderer:layout-mounted`: the
  // latter only fires when the profile already has a project to mount, so on the
  // fresh profile a cold-start run requires it never arrives at all and the app
  // sits on the welcome screen looking hung. `renderer:boot` closes on both
  // paths, and closes at the same place in the same source on both stacks.
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  let bootedAt: number
  for (;;) {
    if (child.exitCode !== null) {
      cleanup()
      return { ...base, note: `exited with code ${String(child.exitCode)} before booting` }
    }
    if (Date.now() > deadline) {
      cleanup()
      return { ...base, note: `no renderer:boot span within ${String(BOOT_TIMEOUT_MS)} ms` }
    }
    if (spanMs(readTrace(tracePath), 'renderer:boot') !== null) {
      bootedAt = Date.now()
      break
    }
    // 25 ms, not 100: the wall-clock figure is quantised to this interval, and
    // at 100 ms the quantisation was the same size as the gap between stacks.
    await sleep(25)
  }

  // Idle: sample the settled tree. The first samples are still boot tail, so
  // the reported figure uses the second half of the window.
  const samples: TreeSample[] = []
  const idleEnd = Date.now() + IDLE_SECONDS * 1000
  while (Date.now() < idleEnd) {
    samples.push(sampleTree(child.pid ?? -1, snapshot()))
    await sleep(1000)
  }

  // One authoritative memory reading at the end of the settled window rather
  // than per-sample: `footprint` is a subprocess per pid, and sampling it every
  // second would add measurable load to the thing being measured.
  const idleMemoryMb = treeMemoryMb(samples[samples.length - 1]?.pids ?? [])

  const trace = readTrace(tracePath)
  const settled = samples.slice(Math.floor(samples.length / 2))
  const first = settled[0]
  const last = settled[settled.length - 1]
  const idleWindowSeconds = Math.max(1, settled.length - 1)

  cleanup()

  return {
    ...base,
    ok: true,
    mainBootCompleteMs: markAt(trace, 'main:boot-complete'),
    rendererBootStartMs: markAt(trace, 'renderer:boot-start'),
    rendererLayoutMountedMs: markAt(trace, 'renderer:layout-mounted'),
    rendererBootSpanMs: spanMs(trace, 'renderer:boot'),
    wallToBootedMs: bootedAt - spawnedAt,
    traceToBootedMs: spanEndAt(trace, 'renderer:boot'),
    idleMemoryMb,
    idleRssMb: last ? Math.round(median(settled.map((s) => s.rssKb)) / 1024) : null,
    idleCpuPercent:
      first && last
        ? Math.round(((last.cpuSeconds - first.cpuSeconds) / idleWindowSeconds) * 1000) / 10
        : null,
    processes: last?.processes ?? null,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// Statistics and reporting
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const low = sorted[mid - 1] ?? Number.NaN
  const high = sorted[mid] ?? Number.NaN
  return sorted.length % 2 === 0 ? (low + high) / 2 : high
}

/**
 * Bytes under a path, resolving the path itself but never following symlinks
 * inside it. Following them double-counts: macOS app bundles are full of
 * internal links, and following those turned the Electron column into 1.8 GB
 * — four times the truth.
 */
function dirBytes(path: string, top = true): number {
  const target = top ? (existsSync(path) ? realpathSync(path) : path) : path
  if (!existsSync(target)) return 0
  const stats = lstatSync(target)
  if (stats.isSymbolicLink()) return 0
  if (!stats.isDirectory()) return stats.size
  let total = 0
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    total += dirBytes(join(target, entry.name), false)
  }
  return total
}

const METRICS: { key: keyof RunResult; label: string; unit: string; lowerIsBetter: boolean }[] = [
  {
    key: 'wallToBootedMs',
    label: 'Cold start → renderer booted (wall clock)',
    unit: 'ms',
    lowerIsBetter: true,
  },
  {
    key: 'traceToBootedMs',
    label: 'Tracer arm → renderer booted',
    unit: 'ms',
    lowerIsBetter: true,
  },
  {
    key: 'rendererLayoutMountedMs',
    label: 'Trace: layout mounted (workspace profiles only)',
    unit: 'ms',
    lowerIsBetter: true,
  },
  {
    key: 'rendererBootSpanMs',
    label: 'Trace: renderer boot span',
    unit: 'ms',
    lowerIsBetter: true,
  },
  {
    key: 'mainBootCompleteMs',
    label: 'Trace: main boot complete',
    unit: 'ms',
    lowerIsBetter: true,
  },
  {
    key: 'idleMemoryMb',
    label: 'Idle memory, whole tree (footprint/PSS)',
    unit: 'MB',
    lowerIsBetter: true,
  },
  {
    key: 'idleRssMb',
    label: 'Idle RSS, whole tree (summed — over-counts sharing)',
    unit: 'MB',
    lowerIsBetter: true,
  },
  { key: 'idleCpuPercent', label: 'Idle CPU', unit: '%', lowerIsBetter: true },
  { key: 'processes', label: 'Processes', unit: '', lowerIsBetter: false },
]

function summarise(results: RunResult[], stacks: Stack[]): string {
  const lines: string[] = []
  lines.push(`| Metric | ${stacks.map((s) => s.label).join(' | ')} |`)
  lines.push(`| --- | ${stacks.map(() => '---').join(' | ')} |`)
  for (const metric of METRICS) {
    const cells = stacks.map((stack) => {
      const values = results
        .filter((r) => r.stack === stack.key && r.ok)
        .map((r) => r[metric.key])
        .filter((v): v is number => typeof v === 'number')
      if (values.length === 0) return 'n/a'
      const mid = Math.round(median(values) * 10) / 10
      const low = Math.round(Math.min(...values) * 10) / 10
      const high = Math.round(Math.max(...values) * 10) / 10
      return `${String(mid)}${metric.unit} (${String(low)}–${String(high)}, n=${String(values.length)})`
    })
    lines.push(`| ${metric.label} | ${cells.join(' | ')} |`)
  }
  const footprints = stacks.map((stack) => {
    const bytes = stack.footprint().reduce((sum, path) => sum + dirBytes(path), 0)
    return bytes === 0 ? 'n/a' : `${String(Math.round(bytes / 1_048_576))}MB`
  })
  // Labelled for what it is: the development tree, not a shipped bundle. The
  // Electron column is node_modules/electron/dist + dist/, which is larger than
  // a packaged app (no pruning, both architectures' helpers on some platforms);
  // the Servo column is a release binary that already embeds dist/renderer.
  // Useful as an order of magnitude, not as a download size.
  lines.push(`| Disk footprint (dev tree) | ${footprints.join(' | ')} |`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const selected = STACKS.filter((stack) => WANTED.includes(stack.key))
if (selected.length === 0) {
  console.error(`no known stacks in --stacks ${WANTED.join(',')}`)
  process.exit(1)
}

const runnable: Stack[] = []
for (const stack of selected) {
  const reason = stack.unavailable()
  if (reason === null) runnable.push(stack)
  // Not fatal: a one-sided run is still worth having, as long as the report
  // says out loud which column is missing and why.
  else console.error(`SKIPPING ${stack.key}: ${reason}`)
}
if (runnable.length === 0) {
  console.error('no stack is runnable here')
  process.exit(1)
}

mkdirSync(OUT_DIR, { recursive: true })
const results: RunResult[] = []
for (let warm = 1; warm <= WARMUP; warm++) {
  for (const stack of runnable) {
    process.stderr.write(`warmup ${String(warm)}/${String(WARMUP)} — ${stack.key}… `)
    const result = await runOnce(
      stack,
      0,
      join(OUT_DIR, 'runs', `${stack.key}-warmup-${String(warm)}`),
    )
    process.stderr.write(result.ok ? 'discarded\n' : `FAILED: ${result.note ?? 'unknown'}\n`)
  }
}
for (let run = 1; run <= RUNS; run++) {
  // Alternate the order each round so neither stack systematically gets the
  // colder page cache or the hotter CPU.
  const order = run % 2 === 0 ? [...runnable].reverse() : runnable
  for (const stack of order) {
    process.stderr.write(`run ${String(run)}/${String(RUNS)} — ${stack.key}… `)
    const result = await runOnce(stack, run, join(OUT_DIR, 'runs', `${stack.key}-${String(run)}`))
    results.push(result)
    process.stderr.write(
      result.ok
        ? `booted ${String(result.wallToBootedMs)}ms, ${String(result.idleMemoryMb ?? result.idleRssMb)}MB\n`
        : `FAILED: ${result.note ?? 'unknown'}\n`,
    )
  }
}

const table = summarise(results, runnable)
writeFileSync(join(OUT_DIR, 'results.json'), `${JSON.stringify({ results }, null, 2)}\n`)
writeFileSync(join(OUT_DIR, 'results.md'), `${table}\n`)
console.log(`\n${table}\n\nraw: ${OUT_DIR}/results.json`)
// Explicit: a stray descendant that outlived its group kill would otherwise
// hold this process open on its inherited stdio.
process.exit(0)
