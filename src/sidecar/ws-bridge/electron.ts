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
 */
import {
  decodeServerFrame,
  encodeFrame,
  WS_AUTH_PROTOCOL_PREFIX,
  type ClientFrame,
  type ServerFrame,
} from '@shared/tauri/ws-protocol.ts'

type Listener = (event: unknown, ...args: unknown[]) => void

const params = new URLSearchParams(window.location.search)
const winId = Number(params.get('winId') ?? '0')
const wsPort = params.get('wsPort')
const wsToken = params.get('wsToken') ?? ''

// The token authenticates this window to the sidecar. Once captured, remove
// it from page-visible location state: this module runs before app.js, and
// nothing after this line — app code or anything injected into the page —
// should be able to recover the credential from `location.search`.
if (params.has('wsToken')) {
  params.delete('wsToken')
  const query = params.toString()
  history.replaceState(
    history.state,
    '',
    `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`,
  )
}

let ready = false
let socket: WebSocket | null = null
const sendQueue: ClientFrame[] = []
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
const listeners = new Map<string, Set<Listener>>()
let nextInvokeId = 1

function push(frame: ClientFrame): void {
  if (ready && socket && socket.readyState === WebSocket.OPEN) {
    socket.send(encodeFrame(frame))
  } else {
    sendQueue.push(frame)
  }
}

function handleFrame(frame: ServerFrame): void {
  if (frame.t === 'hello-ok') {
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

if (wsPort === null) {
  console.error('[ws-bridge] no wsPort in boot URL; window.api will reject every call')
} else {
  // The token subprotocol authenticates the HTTP upgrade itself — the server
  // refuses the handshake without it, before buffering any frame.
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/`, `${WS_AUTH_PROTOCOL_PREFIX}${wsToken}`)
  socket = ws
  ws.addEventListener('open', () => {
    ws.send(encodeFrame({ t: 'hello', winId, token: wsToken }))
  })
  ws.addEventListener('message', (event: MessageEvent) => {
    if (typeof event.data !== 'string') return
    handleFrame(decodeServerFrame(event.data))
  })
  ws.addEventListener('close', () => {
    ready = false
    const error = new Error('sidecar connection closed')
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  })
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
