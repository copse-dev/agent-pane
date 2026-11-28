/**
 * `pnpm run check:local` — the static gate, run as a bounded parallel pool.
 *
 * Every gate is a read-only check of the working tree, and none reads another's
 * output, so running them as one `a && b && …` chain spent most of its wall
 * clock waiting on the slowest three in turn: type-aware ESLint, four `tsc`
 * projects and two type-coverage passes. Here they share a pool sized to the
 * host, and the three slow gates are split into their independent parts (the
 * `&&` parts of `typecheck` and `type-coverage`, and `run-lint`'s shards), so
 * the parts overlap instead of queuing behind each other.
 *
 * What it checks is unchanged: every gate in {@link CHECK_LOCAL_GATES} runs and
 * must pass. Unlike the chain, a failure no longer hides the gates after it;
 * all of them run and every failure is reported at the end.
 *
 *   node scripts/check-local.mts            # pool sized to this host
 *   node scripts/check-local.mts --jobs=1   # one part at a time, as the chain did
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { availableParallelism, totalmem } from 'node:os'
import { delimiter, resolve } from 'node:path'
import { expectRecord, expectStringRecord, parseJsonUnknown } from '../src/shared/unknown-value.mts'
import { isDirectExecution } from './lib/direct-execution.mts'
import { LINT_SHARDS } from './run-lint.mts'

/**
 * The package scripts `check:local` runs. `scripts/ci-workflow-invariants.test.ts`
 * holds CI's precheck to running each of them.
 */
export const CHECK_LOCAL_GATES: readonly string[] = [
  'check:e2e-syntax',
  'typecheck',
  'type-coverage',
  'lint',
  'format:check',
  'demo:site:check',
  'check:dead-code',
  'check:oracle',
  'check:e2e-exclusions',
  'check:a11y-baseline',
  'check:flake-risks',
]

/**
 * Gates whose script is an `&&` chain of independent checks, run as separate
 * parts. Each `typecheck` part is its own `tsc --noEmit` project and each
 * `type-coverage` part its own project pass; none writes anything.
 */
const SPLIT_ON_AND = new Set(['typecheck', 'type-coverage'])

/**
 * Memory to allow per heavy part. A type-aware ESLint shard or type-coverage
 * pass peaked at 3.5 GB resident on a 32 GB Mac. The light gates need a
 * fraction of that and only count against the core limit.
 */
const HEAVY_PART_BYTES = 4 * 1024 ** 3
const MAX_JOBS = 8

export interface CheckPart {
  gate: string
  label: string
  command: string
  /** Holds a TypeScript program: counts against the memory limit and starts first. */
  heavy: boolean
}

/** Parts run at once, and how many of them may be heavy. */
export interface PoolSize {
  jobs: number
  heavy: number
}

export function packageScripts(): Record<string, string> {
  const packageJson = expectRecord(
    parseJsonUnknown(readFileSync(resolve('package.json'), 'utf8')),
    'package.json',
  )
  return expectStringRecord(packageJson['scripts'], 'package.json scripts')
}

const HEAVY_GATES = new Set(['typecheck', 'type-coverage', 'lint'])

/** The parts the pool runs for `gates`, heaviest first. */
export function checkParts(
  scripts: Readonly<Record<string, string>>,
  gates: readonly string[] = CHECK_LOCAL_GATES,
): CheckPart[] {
  const parts: CheckPart[] = []
  for (const gate of gates) {
    const script = scripts[gate]
    if (script === undefined) throw new Error(`package.json has no "${gate}" script`)
    const heavy = HEAVY_GATES.has(gate)
    if (gate === 'lint') {
      LINT_SHARDS.forEach((shard, index) => {
        parts.push({
          gate,
          label: `lint: ${shard.label}`,
          command: `${script} --shard=${String(index)}`,
          heavy,
        })
      })
    } else if (SPLIT_ON_AND.has(gate)) {
      for (const command of script.split(' && ').map((part) => part.trim()))
        parts.push({ gate, label: `${gate}: ${command}`, command, heavy })
    } else {
      parts.push({ gate, label: gate, command: script, heavy })
    }
  }
  return [...parts.filter((part) => part.heavy), ...parts.filter((part) => !part.heavy)]
}

/**
 * The pool for this host: parts bounded by cores, heavy parts by the memory
 * still available when the gate starts. Total memory is the wrong bound on a
 * busy machine: with six heavy parts on a 32 GB Mac whose other apps held most
 * of it, the parts spent their time paging. `jobs` caps both limits, so
 * `jobs: 1` runs one part at a time.
 */
export function poolSize(
  jobs?: number,
  cpus: number = availableParallelism(),
  availableBytes: number = Math.min(totalmem(), process.availableMemory()),
): PoolSize {
  const total = jobs ?? Math.max(1, Math.min(cpus, MAX_JOBS))
  const heavy = Math.max(1, Math.min(total, Math.floor(availableBytes / HEAVY_PART_BYTES)))
  return { jobs: total, heavy }
}

interface PartResult {
  part: CheckPart
  status: number | null
  signal: NodeJS.Signals | null
  seconds: number
  output: string
}

function runPart(part: CheckPart, env: NodeJS.ProcessEnv): Promise<PartResult> {
  const started = performance.now()
  return new Promise((resolvePart) => {
    const chunks: Buffer[] = []
    const child = spawn(part.command, { shell: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk))
    const finish = (status: number | null, signal: NodeJS.Signals | null, extra = ''): void => {
      resolvePart({
        part,
        status,
        signal,
        seconds: (performance.now() - started) / 1000,
        output: Buffer.concat(chunks).toString('utf8') + extra,
      })
    }
    child.on('error', (error) => {
      finish(1, null, `\n${error.message}\n`)
    })
    child.on('close', (status, signal) => {
      finish(status, signal)
    })
  })
}

function report(result: PartResult): void {
  const ok = result.status === 0
  process.stdout.write(
    `\n[check:local] ${ok ? 'ok  ' : 'FAIL'} ${result.part.label} (${result.seconds.toFixed(1)}s)\n` +
      `[check:local]   $ ${result.part.command}\n`,
  )
  if (result.output.trim() !== '') process.stdout.write(result.output.replace(/\n?$/, '\n'))
}

/** Run every part, in order, within the pool's two limits. */
function runPool(parts: readonly CheckPart[], size: PoolSize): Promise<PartResult[]> {
  // As under `pnpm run`, so a part runs the same binaries the chain did.
  const env = {
    ...process.env,
    PATH: `${resolve('node_modules/.bin')}${delimiter}${process.env['PATH'] ?? ''}`,
  }
  const pending = [...parts]
  const results: PartResult[] = []
  let running = 0
  let heavyRunning = 0
  return new Promise((resolveAll) => {
    const startNext = (): void => {
      while (running < size.jobs) {
        const index = pending.findIndex((part) => !part.heavy || heavyRunning < size.heavy)
        const part = index === -1 ? undefined : pending.splice(index, 1)[0]
        if (part === undefined) break
        running++
        if (part.heavy) heavyRunning++
        void runPart(part, env).then((result) => {
          running--
          if (part.heavy) heavyRunning--
          results.push(result)
          report(result)
          if (pending.length === 0 && running === 0) resolveAll(results)
          else startNext()
        })
      }
    }
    if (pending.length === 0) resolveAll(results)
    else startNext()
  })
}

function parseJobs(argv: readonly string[]): number | undefined {
  const flag = argv.find((arg) => arg.startsWith('--jobs='))
  if (flag === undefined) return undefined
  const jobs = Number(flag.slice('--jobs='.length))
  if (!Number.isInteger(jobs) || jobs < 1) {
    console.error(`[check:local] --jobs needs a positive integer, got ${flag}`)
    process.exit(2)
  }
  return jobs
}

async function main(): Promise<void> {
  const size = poolSize(parseJobs(process.argv.slice(2)))
  const parts = checkParts(packageScripts())
  const started = performance.now()
  const at = `${String(size.jobs)} at a time, ${String(size.heavy)} of them heavy`
  console.log(
    `[check:local] ${String(CHECK_LOCAL_GATES.length)} gates as ${String(parts.length)} parts, ${at}`,
  )
  const results = await runPool(parts, size)
  const wall = (performance.now() - started) / 1000
  const failed = results.filter((result) => result.status !== 0)
  console.log('\n[check:local] part times:')
  for (const result of [...results].sort((a, b) => b.seconds - a.seconds))
    console.log(
      `  ${result.seconds.toFixed(1).padStart(6)}s  ${result.status === 0 ? 'ok  ' : 'FAIL'}  ${result.part.label}`,
    )
  const serial = results.reduce((sum, result) => sum + result.seconds, 0)
  console.log(
    `[check:local] ${wall.toFixed(1)}s wall clock for ${serial.toFixed(1)}s of checks (${at})`,
  )
  if (failed.length > 0) {
    console.error(`[check:local] ${String(failed.length)} part(s) failed:`)
    for (const result of failed) {
      const how = result.signal ?? `exit ${String(result.status)}`
      console.error(`  ${result.part.label} (${how}): ${result.part.command}`)
    }
    process.exit(1)
  }
}

// No top-level await: the unit runner bundles this module into split chunks
// for check-local-invariants.test.ts, where esbuild cannot wrap one.
if (isDirectExecution(import.meta.url, 'check-local')) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
