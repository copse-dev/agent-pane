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
 * PROFILE SAFETY. The cost under study is a function of a real profile's size, so
 * a synthetic profile measures nothing. Point `COPSE_DIR` at an APFS clone of
 * `~/.copse` (`cp -Rc`, which is copy-on-write and therefore near-instant and
 * near-free) and the run touches no live state at all — while still reading
 * exactly the bytes the real profile holds:
 *
 *   COPSE_DIR=/tmp/copse-clone node scripts/perf-open.mts --runs 3
 *
 * Without `COPSE_DIR` this runs against the real `~/.copse`, which requires the
 * app to be closed and performs that launch's ordinary startup writes.
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
  // `ELECTRON_RUN_AS_NODE` must be *absent*, not empty — Electron tests for the
  // variable's presence, so passing '' would still start it as plain Node and
  // there would be no window to time.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COPSE_PERF: '1',
    COPSE_PERF_OUT: tracePath,
  }
  delete env['ELECTRON_RUN_AS_NODE']
  const child = spawn(electronBin, ['dist/main/index.js'], {
    cwd: process.cwd(),
    env,
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
