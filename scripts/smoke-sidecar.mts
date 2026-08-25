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

const sidecar = spawn('node', ['dist/sidecar/index.js'], {
  env: {
    ...process.env,
    COPSE_SIDECAR_ENDPOINT_FILE: endpointFile,
    COPSE_DIR: join(scratch, 'copse-home'),
    COPSE_PANEL_USER_DATA: join(scratch, 'user-data'),
  },
  stdio: ['pipe', 'pipe', 'inherit'],
})
sidecar.stdout.on('data', (chunk: Buffer) => process.stdout.write(`[sidecar] ${chunk.toString()}`))

function fail(message: string): never {
  console.error(`SMOKE FAIL: ${message}`)
  sidecar.kill('SIGKILL')
  process.exit(1)
}

// Behind a call so TypeScript doesn't narrow `exitCode` across awaits — the
// process can exit at any point between checks.
function sidecarExited(): boolean {
  return sidecar.exitCode !== null
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

const authProtocol = `copse.auth.${endpoint.token}`

// Authentication starts at the HTTP upgrade: a local peer that cannot present
// the token subprotocol never gets a WebSocket at all, so nothing it sends is
// ever buffered — regardless of size. Assert the handshake is refused.
const tokenlessRefused = await new Promise<boolean>((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${String(endpoint.port)}/`)
  let opened = false
  ws.addEventListener('open', () => {
    opened = true
    ws.close()
  })
  // A refused handshake surfaces as 'error'; whether 'close' follows differs
  // between implementations, so settle on either (double-resolve is inert).
  ws.addEventListener('error', () => {
    resolve(!opened)
  })
  ws.addEventListener('close', () => {
    resolve(!opened)
  })
})
if (!tokenlessRefused) fail('token-less upgrade was accepted; expected handshake refusal')
if (sidecarExited()) fail('token-less upgrade attempt crashed the sidecar')
console.log('token-less upgrade refused at the handshake')

// An upgrade-authenticated peer that then sends garbage must only lose its own
// socket — never crash the sidecar before the real renderer arrives.
const malformedSocket = new WebSocket(`ws://127.0.0.1:${String(endpoint.port)}/`, authProtocol)
const malformedCloseCode = await new Promise<number>((resolve) => {
  malformedSocket.addEventListener('open', () => {
    malformedSocket.send('null')
  })
  malformedSocket.addEventListener('close', (event) => {
    resolve(event.code)
  })
})
if (malformedCloseCode !== 4002) {
  fail(`malformed pre-hello frame closed with ${String(malformedCloseCode)}, expected 4002`)
}
if (sidecar.exitCode !== null) fail(`malformed pre-hello frame crashed the sidecar`)
console.log('malformed pre-hello frame rejected without crashing sidecar')

// The primary window is the shim's first BrowserWindow; its id is 1. Give the
// boot chain time to create it (sandbox init and gortex reaping come first).
const socket = await (async (): Promise<WebSocket> => {
  const connectDeadline = Date.now() + 90_000
  for (;;) {
    const ws = new WebSocket(`ws://127.0.0.1:${String(endpoint.port)}/`, authProtocol)
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

// Attachment-scale traffic must survive the frame bound: the product permits
// 256 MiB videos over `video:attach`, which ride base64-encoded (×4/3) in a
// JSON frame, so the transport must accept frames far beyond typical invoke
// sizes. Send a 40 MiB frame (≈30 MiB of binary — above the ~24 MiB a
// 32 MiB text bound would have allowed) on an allowlisted channel; the extra
// argument is ignored by the handler, so a *result* frame coming back proves
// the transport accepted it. A close instead means the bound regressed.
const bigFrameOutcome = await invoke('settings:get', 'model', 'x'.repeat(40 * 1024 * 1024)).then(
  (value) => ({ ok: true, detail: JSON.stringify(value) }),
  (error: unknown) => ({ ok: false, detail: error instanceof Error ? error.message : '?' }),
)
// A handler-level error result still proves the transport accepted the frame;
// only a dead socket (timeout / connection closed) means the bound regressed.
if (!bigFrameOutcome.ok && /timed out|connection closed/i.test(bigFrameOutcome.detail)) {
  fail(`attachment-scale frame rejected by the transport: ${bigFrameOutcome.detail}`)
}
if (sidecarExited()) fail('attachment-scale frame crashed the sidecar')
console.log(`attachment-scale (40 MiB) frame accepted → ${bigFrameOutcome.detail}`)

// The transport must enforce the preload contract: a channel outside the
// bundle-time allowlist closes the socket (4007) instead of reaching the
// ipcMain handler table — the difference between "no handler" (an invoke
// error result) and rejection at the transport boundary. Runs last: it
// sacrifices the authenticated socket.
const disallowedCloseCode = await new Promise<number>((resolve) => {
  socket.addEventListener(
    'close',
    (event) => {
      resolve(event.code)
    },
    { once: true },
  )
  socket.send(
    JSON.stringify({ t: 'invoke', id: nextId++, channel: 'smoke:not-in-preload', args: [] }),
  )
})
if (disallowedCloseCode !== 4007) {
  fail(`non-preload channel closed with ${String(disallowedCloseCode)}, expected 4007`)
}
if (sidecarExited()) fail('non-preload channel invoke crashed the sidecar')
console.log('non-preload channel rejected at the transport boundary')

console.log('SMOKE PASS')
socket.close()
sidecar.kill('SIGTERM')
setTimeout(() => {
  sidecar.kill('SIGKILL')
  rmSync(scratch, { recursive: true, force: true })
  process.exit(0)
}, 2000)
