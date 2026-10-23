/**
 * Measure the renderer's page load: the time from the main process asking for
 * the window (`main:window-create`) to the renderer's `boot()` starting, and
 * the document's own navigation and paint timings in between.
 *
 * Usage:
 *   pnpm run build
 *   node scripts/perf-page-load.mts [--runs N] [--out DIR] [--dist DIR] [-- <electron args>]
 *
 * On a headless Linux box wrap it in `xvfb-run -a`, and pass `--no-sandbox`
 * after `--` when running as root. Every run gets a fresh, isolated profile
 * under `--out` (default `.perf/`), so nothing in `~/.copse` is read or
 * written. The mock LLM is selected so no provider key is needed. `--dist` points
 * at another build output (a copy of `dist/` from a different commit) so two
 * builds can be measured back to back on the same machine state.
 *
 * What the numbers mean (all milliseconds):
 *   window→boot   `main:window-create` → `renderer:boot-start` from the
 *                 COPSE_PERF trace: the whole page load as the user feels it,
 *                 up to the first line of the renderer's `boot()`.
 *   interactive   `domInteractive`: index.html parsed; `app.js` is still
 *                 compiling (V8 parses the module on a background thread).
 *   DCL           `domContentLoaded`: `app.js` has been evaluated. The gap
 *                 from `interactive` is the bundle's compile + evaluate cost
 *                 and therefore tracks the size of the eager bundle.
 *   FCP           `first-contentful-paint`.
 *   boot          `renderer:boot` span: boot() start → restored project shown.
 *
 * Reads a Chrome DevTools Protocol target over `--remote-debugging-port`, so the
 * page is measured as loaded, not reloaded (a reload is warm: V8's code cache
 * would hide the compile cost this script exists to show).
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import WebSocket from 'ws'
import { decodeWithSchema, safeJsonParse } from './lib/safe-json.mts'

const argv = process.argv.slice(2)
const passthroughStart = argv.indexOf('--')
const ownArgs = passthroughStart >= 0 ? argv.slice(0, passthroughStart) : argv
const electronArgs = passthroughStart >= 0 ? argv.slice(passthroughStart + 1) : []

function flag(name: string, fallback: string): string {
  const i = ownArgs.indexOf(`--${name}`)
  const value = i >= 0 ? ownArgs[i + 1] : undefined
  return value ?? fallback
}
const runs = Math.max(1, Number(flag('runs', '3')) || 1)
const outDir = resolve(flag('out', join(process.cwd(), '.perf')))
mkdirSync(outDir, { recursive: true })
const distDir = resolve(flag('dist', 'dist'))
const mainEntry = join(distDir, 'main', 'index.js')

const electronBin = join(process.cwd(), 'node_modules', '.bin', 'electron')
if (!existsSync(mainEntry)) {
  console.error(`${mainEntry} missing — run \`pnpm run build\` first.`)
  process.exit(2)
}

const targetSchema = z.array(
  z.object({
    type: z.string(),
    url: z.string(),
    webSocketDebuggerUrl: z.string().optional(),
  }),
)
const cdpResponseSchema = z.object({
  id: z.number().optional(),
  result: z.object({ result: z.object({ value: z.unknown().optional() }).optional() }).optional(),
})
const pageTimingSchema = z.object({
  mounted: z.boolean(),
  domInteractive: z.number(),
  domContentLoaded: z.number(),
  loadEventEnd: z.number(),
  firstPaint: z.number().nullable(),
  firstContentfulPaint: z.number().nullable(),
})
type PageTiming = z.infer<typeof pageTimingSchema>
const perfRecordSchema = z.object({
  t: z.number(),
  kind: z.enum(['mark', 'span']),
  name: z.string(),
  ms: z.number().optional(),
})

interface RunResult extends PageTiming {
  windowToBoot: number | null
  boot: number | null
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function listTargets(port: number): Promise<z.infer<typeof targetSchema>> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`)
    return safeJsonParse(await response.text(), decodeWithSchema(targetSchema)) ?? []
  } catch {
    return []
  }
}

/** The page's own view of the load, read in place over CDP. */
const PAGE_TIMING_EXPRESSION = `(() => {
  const nav = performance.getEntriesByType('navigation')[0]
  const paint = (name) => performance.getEntriesByName(name, 'paint')[0]?.startTime ?? null
  const mounted =
    document.readyState === 'complete' &&
    ((document.querySelector('#conversation')?.children.length ?? 0) > 0 ||
      (document.querySelector('#welcome')?.children.length ?? 0) > 0)
  return JSON.stringify({
    mounted,
    domInteractive: nav?.domInteractive ?? -1,
    domContentLoaded: nav?.domContentLoadedEventStart ?? -1,
    loadEventEnd: nav?.loadEventEnd ?? -1,
    firstPaint: paint('first-paint'),
    firstContentfulPaint: paint('first-contentful-paint'),
  })
})()`

async function readPageTiming(socketUrl: string): Promise<PageTiming | null> {
  const socket = new WebSocket(socketUrl)
  await new Promise<void>((done, fail) => {
    socket.once('open', () => {
      done()
    })
    socket.once('error', fail)
  })
  let nextId = 0
  const pending = new Map<number, (value: unknown) => void>()
  socket.on('message', (data: WebSocket.RawData) => {
    const text = Buffer.isBuffer(data)
      ? data.toString()
      : Array.isArray(data)
        ? Buffer.concat(data).toString()
        : Buffer.from(data).toString()
    const message = safeJsonParse(text, decodeWithSchema(cdpResponseSchema))
    if (message?.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)?.(message.result?.result?.value)
      pending.delete(message.id)
    }
  })
  const evaluate = (expression: string): Promise<unknown> =>
    new Promise((done) => {
      const id = ++nextId
      pending.set(id, done)
      socket.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true },
        }),
      )
    })
  try {
    // The shell mounts a few hundred milliseconds after the load event; poll
    // until it has, so `mounted` doubles as "the app really came up".
    const deadline = Date.now() + 30_000
    let timing: PageTiming | null = null
    while (Date.now() < deadline) {
      const raw = await evaluate(PAGE_TIMING_EXPRESSION)
      timing =
        typeof raw === 'string' ? safeJsonParse(raw, decodeWithSchema(pageTimingSchema)) : null
      if (timing?.mounted) break
      await sleep(200)
    }
    return timing
  } finally {
    socket.close()
  }
}

function readPerfMarks(tracePath: string): { windowToBoot: number | null; boot: number | null } {
  if (!existsSync(tracePath)) return { windowToBoot: null, boot: null }
  let windowCreate: number | null = null
  let bootStart: number | null = null
  let boot: number | null = null
  for (const line of readFileSync(tracePath, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    const record = safeJsonParse(line, decodeWithSchema(perfRecordSchema))
    if (!record) continue
    if (record.name === 'main:window-create') windowCreate ??= record.t
    if (record.name === 'renderer:boot-start') bootStart ??= record.t
    if (record.name === 'renderer:boot' && record.kind === 'span') boot ??= record.ms ?? null
  }
  return {
    windowToBoot: windowCreate !== null && bootStart !== null ? bootStart - windowCreate : null,
    boot,
  }
}

async function runOnce(index: number): Promise<RunResult | null> {
  const profile = join(outDir, `page-load-profile-${String(index)}`)
  rmSync(profile, { recursive: true, force: true })
  mkdirSync(profile, { recursive: true })
  const tracePath = join(outDir, `page-load-${String(index)}.ndjson`)
  rmSync(tracePath, { force: true })
  const port = 9222 + index
  // `ELECTRON_RUN_AS_NODE` must be absent, not empty: Electron tests for the
  // variable's presence.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COPSE_DIR: profile,
    COPSE_PANEL_USER_DATA: profile,
    COPSE_WORKSPACE_DIR: join(profile, 'workspace'),
    COPSE_WORKTREES_DIR: join(profile, 'worktrees'),
    COPSE_PLUGINS_DIR: join(profile, 'plugins'),
    COPSE_PANEL_MOCK_LLM: '1',
    COPSE_PERF: '1',
    COPSE_PERF_OUT: tracePath,
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    CURSOR_API_KEY: '',
  }
  delete env['ELECTRON_RUN_AS_NODE']
  const child = spawn(
    electronBin,
    [mainEntry, `--remote-debugging-port=${String(port)}`, ...electronArgs],
    { cwd: process.cwd(), env, stdio: ['ignore', 'ignore', 'pipe'] },
  )
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  let timing: PageTiming | null
  try {
    const deadline = Date.now() + 30_000
    let socketUrl: string | undefined
    while (Date.now() < deadline && socketUrl === undefined) {
      const page = (await listTargets(port)).find(
        (target) => target.type === 'page' && target.url.includes('renderer/index.html'),
      )
      socketUrl = page?.webSocketDebuggerUrl
      if (socketUrl === undefined) await sleep(100)
    }
    if (socketUrl === undefined) {
      console.error(`run ${String(index)}: no renderer page appeared\n${stderr.slice(-2000)}`)
      return null
    }
    timing = await readPageTiming(socketUrl)
  } finally {
    // SIGTERM lets the app flush the perf trace; escalate only if it hangs.
    child.kill('SIGTERM')
    await Promise.race([new Promise((r) => child.once('exit', r)), sleep(8_000)])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  if (!timing) return null
  return { ...timing, ...readPerfMarks(tracePath) }
}

function median(values: (number | null)[]): string {
  const sorted = values.filter((v): v is number => v !== null).sort((a, b) => a - b)
  if (sorted.length === 0) return '—'
  const mid = Math.floor(sorted.length / 2)
  const value =
    sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
  return value.toFixed(0)
}

const cell = (value: number | null): string => (value === null ? '—' : value.toFixed(0))

const results: RunResult[] = []
for (let i = 1; i <= runs; i++) {
  const result = await runOnce(i)
  if (result) results.push(result)
  if (result && !result.mounted) console.warn(`run ${String(i)}: the app shell never mounted`)
}

console.log('\nrun  window→boot  interactive   DCL   FCP   boot')
results.forEach((r, i) => {
  console.log(
    [
      String(i + 1).padEnd(3),
      cell(r.windowToBoot).padStart(11),
      cell(r.domInteractive).padStart(12),
      cell(r.domContentLoaded).padStart(5),
      cell(r.firstContentfulPaint).padStart(5),
      cell(r.boot).padStart(6),
    ].join('  '),
  )
})
console.log(
  [
    'med',
    median(results.map((r) => r.windowToBoot)).padStart(11),
    median(results.map((r) => r.domInteractive)).padStart(12),
    median(results.map((r) => r.domContentLoaded)).padStart(5),
    median(results.map((r) => r.firstContentfulPaint)).padStart(5),
    median(results.map((r) => r.boot)).padStart(6),
  ].join('  '),
)
if (results.length < runs) process.exitCode = 1
