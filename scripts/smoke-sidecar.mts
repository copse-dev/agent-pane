/**
 * Headless smoke test for the Tauri sidecar (see tauri-shell/README.md).
 *
 * Boots dist/sidecar/index.js as a plain Node process — no Tauri shell, no
 * display — connects to its loopback WebSocket exactly as the Servo webview's
 * ws-bridge would, authenticates with the per-launch token, and drives a few
 * real invoke channels end-to-end. Proves the electron shim + WS transport
 * carry the existing main process without Electron present.
 *
 * Uses an isolated COPSE_DIR so a dev machine's real profile is untouched.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'copse-sidecar-smoke-'))
const endpointFile = join(scratch, 'endpoint.json')
const perfOut = join(scratch, 'perf.ndjson')

const sidecar = spawn('node', ['dist/sidecar/index.js'], {
  env: {
    ...process.env,
    COPSE_SIDECAR_ENDPOINT_FILE: endpointFile,
    COPSE_DIR: join(scratch, 'copse-home'),
    COPSE_PANEL_USER_DATA: join(scratch, 'user-data'),
    // Perf tracing on, so this test also covers the measurement path the
    // Electron-vs-Servo comparison depends on: the boot URL must carry the
    // tracer's env for the webview (ws-bridge/perf-env.ts), and renderer
    // records must reach main's NDJSON stream over the WS `send` path.
    COPSE_PERF: '1',
    COPSE_PERF_OUT: perfOut,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})
// Kept, not just forwarded: with no shell attached the shell-link reports the
// create-window message — and with it the renderer's boot URL — on stderr, and
// that URL is asserted on below.
let sidecarOutput = ''
function capture(stream: NodeJS.ReadableStream, label: string): void {
  stream.on('data', (chunk: Buffer) => {
    sidecarOutput += chunk.toString()
    process.stdout.write(`[${label}] ${chunk.toString()}`)
  })
}
capture(sidecar.stdout, 'sidecar')
capture(sidecar.stderr, 'sidecar-err')

function fail(message: string): never {
  console.error(`SMOKE FAIL: ${message}`)
  sidecar.kill('SIGKILL')
  process.exit(1)
}

const deadline = Date.now() + 90_000
while (!existsSync(endpointFile)) {
  if (Date.now() > deadline) fail('endpoint file never appeared')
  if (sidecar.exitCode !== null) fail(`sidecar exited early with code ${String(sidecar.exitCode)}`)
  await new Promise((r) => setTimeout(r, 250))
}
// Written by our own ws-server; shape is trusted.
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
const endpoint = JSON.parse(readFileSync(endpointFile, 'utf8')) as {
  port: number
  token: string
}
console.log(`endpoint up on 127.0.0.1:${String(endpoint.port)}`)

// An unauthenticated local peer can discover the ephemeral port, but malformed
// input must only close that socket — never crash the sidecar before the real
// renderer arrives.
const malformedSocket = new WebSocket(`ws://127.0.0.1:${String(endpoint.port)}/`)
const malformedCloseCode = await new Promise<number>((resolve) => {
  malformedSocket.addEventListener('open', () => {
    malformedSocket.send('null')
  })
  malformedSocket.addEventListener('close', (event) => {
    resolve(event.code)
  })
})
if (malformedCloseCode !== 4002) {
  fail(`malformed pre-auth frame closed with ${String(malformedCloseCode)}, expected 4002`)
}
if (sidecar.exitCode !== null) fail(`malformed pre-auth frame crashed the sidecar`)
console.log('malformed pre-auth frame rejected without crashing sidecar')

// The primary window is the shim's first BrowserWindow; its id is 1. Give the
// boot chain time to create it (sandbox init and gortex reaping come first).
const socket = await (async (): Promise<WebSocket> => {
  const connectDeadline = Date.now() + 90_000
  for (;;) {
    const ws = new WebSocket(`ws://127.0.0.1:${String(endpoint.port)}/`)
    const outcome = await new Promise<'ok' | 'closed'>((resolve) => {
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ t: 'hello', winId: 1, token: endpoint.token }))
      })
      ws.addEventListener('message', (event) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const frame = JSON.parse(String(event.data)) as { t: string }
        if (frame.t === 'hello-ok') resolve('ok')
      })
      ws.addEventListener('close', () => {
        resolve('closed')
      })
    })
    if (outcome === 'ok') return ws
    if (Date.now() > connectDeadline) fail('could not authenticate against window 1')
    await new Promise((r) => setTimeout(r, 500))
  }
})()
console.log('authenticated as renderer for window 1')

let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
socket.addEventListener('message', (event) => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const frame = JSON.parse(String(event.data)) as {
    t: string
    id?: number
    ok?: boolean
    value?: unknown
    error?: string
    channel?: string
  }
  if (frame.t === 'result' && frame.id !== undefined) {
    const entry = pending.get(frame.id)
    if (!entry) return
    pending.delete(frame.id)
    if (frame.ok) entry.resolve(frame.value)
    else entry.reject(new Error(frame.error))
  }
  if (frame.t === 'event') console.log(`event: ${frame.channel ?? ''}`)
})

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ t: 'invoke', id, channel, args }))
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`invoke ${channel} timed out`))
    }, 30_000)
  })
}

const home = await invoke('workspace:getHomeDirectory')
if (typeof home !== 'string' || home.length === 0)
  fail(`workspace:getHomeDirectory → ${String(home)}`)
console.log(`workspace:getHomeDirectory → ${home}`)

const model = await invoke('settings:get', 'model')
console.log(`settings:get model → ${JSON.stringify(model)}`)

const trusted = await invoke('workspace:isTrusted')
console.log(`workspace:isTrusted → ${JSON.stringify(trusted)}`)

// A guarded channel must also work (assertMainFrameSender against the shim's
// fabricated senderFrame) — settings:get above is already guarded in
// register-handlers, but hit a second cluster for good measure.
const navigation = await invoke('mainWindow:getNavigation')
console.log(`mainWindow:getNavigation → ${JSON.stringify(navigation)}`)

// The perf tracer's renderer half has no environment to inherit under Servo,
// so main publishes it on the boot URL instead. Without these two parameters
// `ws-bridge.js` silently records nothing and a comparison run yields main-only
// traces that look plausible and are half missing.
const bootUrl = /"url":"(tauri\.html\?[^"]*)"/.exec(sidecarOutput)?.[1] ?? ''
if (!bootUrl) fail('never saw a create-window message for the primary window')
if (!/[?&]copsePerf=1(&|$)/.test(bootUrl))
  fail(`boot URL carries no copsePerf under COPSE_PERF=1: ${bootUrl}`)
if (!/copsePerfOrigin=\d{13}/.test(bootUrl))
  fail(`boot URL carries no wall-clock perf origin: ${bootUrl}`)
console.log('boot URL carries the perf tracer env for the webview')

// `send` is the channel the renderer's perf bridge uses; prove a record makes
// it all the way into the one NDJSON stream that holds main's marks too.
socket.send(
  JSON.stringify({
    t: 'send',
    channel: 'perf:record',
    args: [{ t: 1, kind: 'span', src: 'renderer', name: 'smoke:probe', ms: 4.2 }],
  }),
)
// The tracer buffers and flushes on a 250 ms timer.
await new Promise((r) => setTimeout(r, 1500))
const trace = existsSync(perfOut) ? readFileSync(perfOut, 'utf8') : ''
if (!trace.includes('"name":"main:boot-complete"'))
  fail('perf trace has no main-process boot records')
if (!trace.includes('"name":"smoke:probe"'))
  fail('renderer perf record never reached the main NDJSON stream')
console.log('renderer perf records reach the shared NDJSON trace')

console.log('SMOKE PASS')
socket.close()
sidecar.kill('SIGTERM')
setTimeout(() => {
  sidecar.kill('SIGKILL')
  rmSync(scratch, { recursive: true, force: true })
  process.exit(0)
}, 2000)
