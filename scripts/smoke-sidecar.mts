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

// Same posture for size: authentication happens only after a whole frame is
// buffered, so the server's maxPayload bound (32 MiB) is what stops an
// unauthenticated peer from making the sidecar buffer arbitrary amounts.
// ws closes an oversized message with 1009 before it ever reaches decode.
const oversizedSocket = new WebSocket(`ws://127.0.0.1:${String(endpoint.port)}/`)
const oversizedCloseCode = await new Promise<number>((resolve) => {
  oversizedSocket.addEventListener('open', () => {
    oversizedSocket.send('x'.repeat(32 * 1024 * 1024 + 64))
  })
  oversizedSocket.addEventListener('close', (event) => {
    resolve(event.code)
  })
})
if (oversizedCloseCode !== 1009) {
  fail(`oversized pre-auth frame closed with ${String(oversizedCloseCode)}, expected 1009`)
}
if (sidecarExited()) fail(`oversized pre-auth frame crashed the sidecar`)
console.log('oversized pre-auth frame rejected without crashing sidecar')

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
