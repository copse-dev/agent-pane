/**
 * Launch Copse with tracing on, wait for the open to finish, quit, and report.
 *
 * Usage:
 *   node scripts/perf-open.mts [--runs N] [--out DIR] [--keep-open]
 *
 * Measures a *cold open*: process start → the restored project's threads loaded
 * and applied to the store. That is the delay the user described, and it is the
 * one thing that can be measured without driving the UI, because Copse reopens
 * the last active project on launch.
 *
 * PROFILE SAFETY. This runs against the real `~/.copse` (that is the point — the
 * cost is a function of that profile's size, and a synthetic profile would
 * measure nothing). It never writes to the profile itself: the trace goes to
 * `--out`, outside `~/.copse`. The app does its own normal startup writes, the
 * same ones any launch performs.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
function flag(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? String(args[i + 1]) : fallback
}
const runs = Number(flag('runs', '1'))
const outDir = resolve(flag('out', join(process.cwd(), '.perf')))
const keepOpen = args.includes('--keep-open')

mkdirSync(outDir, { recursive: true })

const electronBin = join(process.cwd(), 'node_modules', '.bin', 'electron')
if (!existsSync(join(process.cwd(), 'dist', 'main', 'index.js'))) {
  console.error('dist/main/index.js missing — run `pnpm run build` first.')
  process.exit(2)
}

/**
 * One launch. Resolves when the renderer reports the restored project is on
 * screen (`renderer:restore-project` completing), or on timeout — a timeout is
 * itself a result worth reporting rather than an error to retry.
 */
async function runOnce(index: number): Promise<string> {
  const tracePath = join(outDir, `open-${String(index)}.ndjson`)
  const child = spawn(electronBin, ['dist/main/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      COPSE_PERF: '1',
      COPSE_PERF_OUT: tracePath,
      // Keep Electron from re-exec'ing as plain node (the repo's `start` script
      // does the same).
      ELECTRON_RUN_AS_NODE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let settled = false
  const started = Date.now()
  await new Promise<void>((done) => {
    const finish = (): void => {
      if (settled) return
      settled = true
      done()
    }
    const watch = (buf: Buffer): void => {
      const text = buf.toString()
      process.stdout.write(text.replace(/^/gm, `  [run ${String(index)}] `))
      // `[startup] boot-complete` is the app's own existing signal; the trace
      // carries the finer detail.
      if (text.includes('[startup] boot-complete')) {
        // Give the renderer's project restore a moment to land after boot.
        setTimeout(finish, 4_000)
      }
    }
    child.stdout.on('data', watch)
    child.stderr.on('data', watch)
    child.on('exit', finish)
    setTimeout(finish, 120_000)
  })

  console.log(`\n  run ${String(index)}: window up after ${String(Date.now() - started)}ms`)
  if (!keepOpen) {
    child.kill('SIGTERM')
    // SIGTERM lets `cleanupBeforeQuit` flush the trace; escalate only if it hangs.
    await new Promise((r) => setTimeout(r, 2_000))
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  return tracePath
}

const traces: string[] = []
for (let i = 1; i <= runs; i++) {
  console.log(`\n=== Run ${String(i)} of ${String(runs)} ===`)
  traces.push(await runOnce(i))
}

console.log('\nTraces written:')
for (const t of traces) console.log(`  ${t}`)
console.log(`\nReport with:\n  node scripts/perf-report.mts ${traces[0] ?? ''}\n`)
