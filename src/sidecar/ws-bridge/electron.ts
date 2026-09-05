/**
 * Browser-side replacement for the `electron` module, WebSocket-backed.
 *
 * `scripts/build-tauri.mts` bundles the real preload (`src/preload/index.ts`)
 * for the Servo webview with an esbuild alias mapping `electron` → this file,
 * so the entire `window.api` surface ports verbatim: `contextBridge` becomes a
 * plain window assignment (no context isolation in this page — the bridge IS
 * the page's transport), and `ipcRenderer` speaks the ws-protocol frames to
 * the sidecar.
 *
 * The socket connects asynchronously but `window.api` must exist before
 * app.js evaluates (same guarantee Electron's preload gives), so `invoke` and
 * `send` buffer until the `hello-ok` handshake lands.
 *
 * Connection side effects live in `startBridge()` (called from `entry.ts`
 * *after* the preload runs). Importing this module must be side-effect free
 * beyond reading the boot URL: Servo can throw from `history.replaceState` or
 * `WebSocket` on the custom scheme, and a throw during module evaluation would
 * abort before `exposeInMainWorld('api', …)`, leaving app.js with
 * `window.api === undefined` (`can't access property "settings", api…`).
 */
import {
  decodeServerFrame,
  encodeFrame,
  WS_AUTH_PROTOCOL_PREFIX,
  type ClientFrame,
  type ServerFrame,
} from '@shared/tauri/ws-protocol.ts'
import { API_PROTOCOL_VERSION } from '@shared/api-protocol.mts'

type Listener = (event: unknown, ...args: unknown[]) => void

const params = new URLSearchParams(window.location.search)
const winId = Number(params.get('winId') ?? '0')
const wsPort = params.get('wsPort')
const wsToken = params.get('wsToken') ?? ''

let ready = false
let socket: WebSocket | null = null
const sendQueue: ClientFrame[] = []
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
const listeners = new Map<string, Set<Listener>>()
let nextInvokeId = 1
let started = false

/** Reject everything in flight; the socket is not going to answer. */
function failPending(error: Error): void {
  ready = false
  sendQueue.length = 0
  for (const entry of pending.values()) entry.reject(error)
  pending.clear()
}

function push(frame: ClientFrame): void {
  if (ready && socket && socket.readyState === WebSocket.OPEN) {
    socket.send(encodeFrame(frame))
  } else {
    sendQueue.push(frame)
  }
}

function handleFrame(frame: ServerFrame): void {
  if (frame.t === 'hello-ok') {
    // Both ends check: the server refuses a `hello` whose version it does not
    // speak (4008), and the client refuses a `hello-ok` from a server it does
    // not speak. Checking only one direction leaves the client trusting
    // whatever answers the socket — exactly the case the daemon split creates,
    // where the two halves are built and shipped separately.
    if (frame.protocolVersion !== API_PROTOCOL_VERSION) {
      const detail = `server speaks API protocol v${String(frame.protocolVersion)}, this client v${String(API_PROTOCOL_VERSION)}`
      console.error(`[ws-bridge] refusing the sidecar handshake: ${detail}`)
      failPending(new Error(`API protocol version mismatch: ${detail}`))
      socket?.close(4008, 'protocol version mismatch')
      return
    }
    ready = true
    for (const queued of sendQueue.splice(0)) push(queued)
    return
  }
  if (frame.t === 'result') {
    const entry = pending.get(frame.id)
    if (!entry) return
    pending.delete(frame.id)
    if (frame.ok) entry.resolve(frame.value)
    else entry.reject(new Error(frame.error ?? 'invoke failed'))
    return
  }
  // event
  const set = listeners.get(frame.channel)
  if (!set) return
  for (const listener of [...set]) listener({}, ...frame.args)
}

function scrubBootToken(): void {
  // The token authenticates this window to the sidecar. Once captured, remove
  // it from page-visible location state: this runs before app.js, and nothing
  // after — app code or anything injected into the page — should be able to
  // recover the credential from `location.search`.
  // Servo can reject history.replaceState on custom schemes; scrub failure
  // must not take down the bridge script.
  if (wsToken === '') return
  const scrubbed = new URLSearchParams(window.location.search)
  scrubbed.delete('wsToken')
  const query = scrubbed.toString()
  try {
    const next = new URL(window.location.href)
    next.search = query
    history.replaceState(history.state, '', next.href)
  } catch (err) {
    console.error('[ws-bridge] could not scrub wsToken from the URL', err)
  }
}

function openSocket(): void {
  if (wsPort === null) {
    console.error('[ws-bridge] no wsPort in boot URL; window.api will reject every call')
    return
  }
  // The token subprotocol authenticates the HTTP upgrade itself — the server
  // refuses the handshake without it, before buffering any frame.
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/`, `${WS_AUTH_PROTOCOL_PREFIX}${wsToken}`)
    socket = ws
    ws.addEventListener('open', () => {
      ws.send(
        encodeFrame({ t: 'hello', winId, token: wsToken, protocolVersion: API_PROTOCOL_VERSION }),
      )
    })
    ws.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string') return
      handleFrame(decodeServerFrame(event.data))
    })
    ws.addEventListener('close', () => {
      failPending(new Error('sidecar connection closed'))
    })
  } catch (err) {
    console.error('[ws-bridge] failed to open WebSocket to the sidecar', err)
  }
}

/**
 * Open the sidecar socket and scrub the boot token from the URL.
 * Must run after the preload has installed `window.api`.
 */
export function startBridge(): void {
  if (started) return
  started = true
  scrubBootToken()
  openSocket()
}

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: Listener): IpcRendererLike
  once(channel: string, listener: Listener): IpcRendererLike
  off(channel: string, listener: Listener): IpcRendererLike
  removeListener(channel: string, listener: Listener): IpcRendererLike
  removeAllListeners(channel?: string): IpcRendererLike
}

export const ipcRenderer: IpcRendererLike = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (wsPort === null) return Promise.reject(new Error('no sidecar endpoint in boot URL'))
    const id = nextInvokeId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      push({ t: 'invoke', id, channel, args })
    })
  },
  send(channel: string, ...args: unknown[]): void {
    push({ t: 'send', channel, args })
  },
  on(channel: string, listener: Listener): IpcRendererLike {
    let set = listeners.get(channel)
    if (!set) {
      set = new Set()
      listeners.set(channel, set)
    }
    set.add(listener)
    return ipcRenderer
  },
  once(channel: string, listener: Listener): IpcRendererLike {
    const wrapped: Listener = (event, ...args) => {
      ipcRenderer.removeListener(channel, wrapped)
      listener(event, ...args)
    }
    return ipcRenderer.on(channel, wrapped)
  },
  off(channel: string, listener: Listener): IpcRendererLike {
    return ipcRenderer.removeListener(channel, listener)
  },
  removeListener(channel: string, listener: Listener): IpcRendererLike {
    listeners.get(channel)?.delete(listener)
    return ipcRenderer
  },
  removeAllListeners(channel?: string): IpcRendererLike {
    if (channel === undefined) listeners.clear()
    else listeners.delete(channel)
    return ipcRenderer
  },
}

export const contextBridge = {
  exposeInMainWorld(key: string, value: unknown): void {
    Reflect.set(window, key, value)
  },
}
