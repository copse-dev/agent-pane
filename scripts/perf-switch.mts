/**
 * Measure the cost of *switching* projects, by driving a real click.
 *
 * Usage:
 *   COPSE_DIR=/tmp/copse-clone node scripts/perf-switch.mts <projectPathA> <projectPathB> [...]
 *
 * A cold open can be measured without touching the UI, because Copse reopens the
 * last active project on launch. A switch cannot — so this attaches to the
 * renderer over CDP and clicks the sidebar row, exactly as a user would.
 *
 * Driving the real DOM matters. The alternative — exposing a "switch project"
 * hook on `window` for the harness to call — would measure a code path no user
 * ever takes, and would leave a test-only entry point in the product. Clicking
 * `button.project-row` goes through the same listener, the same `switchProject`,
 * and the same store updates as a genuine click.
 *
 * The `switch:activate` span and its three children (`switch:workspace-set`,
 * `switch:load-threads`, `switch:apply-state`) then bracket exactly one click.
 */

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const targets = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (targets.length < 2) {
  console.error('usage: node scripts/perf-switch.mts <projectPathA> <projectPathB> [...]')
  process.exit(2)
}
const outDir = resolve(process.env['PERF_OUT_DIR'] ?? join(process.cwd(), '.perf'))
mkdirSync(outDir, { recursive: true })
const tracePath = join(outDir, 'switch.ndjson')
const PORT = 9223

const env: NodeJS.ProcessEnv = { ...process.env, COPSE_PERF: '1', COPSE_PERF_OUT: tracePath }
delete env['ELECTRON_RUN_AS_NODE']

const child = spawn(
  join(process.cwd(), 'node_modules', '.bin', 'electron'),
  ['dist/main/index.js', `--remote-debugging-port=${String(PORT)}`],
  { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] },
)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let booted = false
const onOutput = (buf: Buffer): void => {
  if (buf.toString().includes('[startup] boot-complete')) booted = true
}
child.stdout.on('data', onOutput)
child.stderr.on('data', onOutput)

interface CdpTarget {
  type: string
  url: string
  webSocketDebuggerUrl?: string
}

/** The main window's renderer, once devtools has published it. */
async function findRenderer(): Promise<string> {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${String(PORT)}/json/list`)
      const parsed: unknown = await res.json()
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (typeof entry !== 'object' || entry === null) continue
          const target: CdpTarget = {
            type: String(Reflect.get(entry, 'type') ?? ''),
            url: String(Reflect.get(entry, 'url') ?? ''),
            ...(typeof Reflect.get(entry, 'webSocketDebuggerUrl') === 'string'
              ? { webSocketDebuggerUrl: String(Reflect.get(entry, 'webSocketDebuggerUrl')) }
              : {}),
          }
          // `index.html` and not a devtools/popout page.
          if (
            target.type === 'page' &&
            target.url.includes('index.html') &&
            !target.url.includes('devtools') &&
            target.webSocketDebuggerUrl
          ) {
            return target.webSocketDebuggerUrl
          }
        }
      }
    } catch {
      // Devtools endpoint not up yet.
    }
    await sleep(500)
  }
  throw new Error('renderer target never appeared on the CDP endpoint')
}

/** One CDP `Runtime.evaluate`, returning the expression's JSON value. */
function evaluate(ws: WebSocket, id: number, expression: string): Promise<unknown> {
  return new Promise((resolveValue, rejectValue) => {
    const onMessage = (event: MessageEvent): void => {
      const parsed: unknown = JSON.parse(String(event.data))
      if (typeof parsed !== 'object' || parsed === null) return
      if (Reflect.get(parsed, 'id') !== id) return
      ws.removeEventListener('message', onMessage)
      const result: unknown = Reflect.get(Reflect.get(parsed, 'result') ?? {}, 'result')
      resolveValue(
        typeof result === 'object' && result !== null ? Reflect.get(result, 'value') : undefined,
      )
    }
    ws.addEventListener('message', onMessage)
    ws.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true },
      }),
    )
    setTimeout(() => {
      rejectValue(new Error('CDP evaluate timed out'))
    }, 30_000)
  })
}

while (!booted) await sleep(250)
await sleep(3_000)

const wsUrl = await findRenderer()
const ws = new WebSocket(wsUrl)
await new Promise<void>((r) => {
  ws.addEventListener('open', () => {
    r()
  })
})

let messageId = 1
for (const [index, path] of targets.entries()) {
  // Click by the row's `title`, which the sidebar sets to the project path.
  const expression = `(() => {
    const rows = [...document.querySelectorAll('button.project-row')]
    const row = rows.find((r) => r.title === ${JSON.stringify(path)} || r.title.startsWith(${JSON.stringify(path)} + ' —'))
    if (!row) return 'NOT FOUND: ' + rows.map((r) => r.title).join(' | ')
    row.click()
    return 'clicked ' + row.textContent
  })()`
  const outcome = await evaluate(ws, messageId++, expression)
  console.log(`  click ${String(index + 1)}/${String(targets.length)}: ${String(outcome)}`)
  // Long enough for the slowest switch observed to complete and settle.
  await sleep(20_000)
}

ws.close()
child.kill('SIGTERM')
await sleep(2_000)
if (child.exitCode === null) child.kill('SIGKILL')
console.log(`\nTrace: ${tracePath}\n  node scripts/perf-report.mts ${tracePath}\n`)
