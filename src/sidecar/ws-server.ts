/**
 * The sidecar's loopback WebSocket server — the transport that replaces
 * Electron's in-process IPC in the Tauri prototype.
 *
 * One WS connection ↔ one shim BrowserWindow, bound by the `hello` frame's
 * `winId` + per-launch bearer token (both delivered to the renderer only via
 * the boot URL the shell loads). Invokes dispatch into the same handler table
 * `src/main` registered through the shimmed `ipcMain`; `webContents.send`
 * events flow back on the same socket. See src/shared/tauri/ws-protocol.ts
 * for frames and docs/plans/tauri-servo-migration.md for the trust model.
 */
import { WebSocketServer } from 'ws'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import {
  decodeClientFrame,
  encodeFrame,
  type ClientFrame,
  type ServerFrame,
} from '@shared/tauri/ws-protocol.ts'
import { sidecarInternals } from './electron-shim/index.ts'
import { MAX_VIDEO_BYTES } from '@shared/video/video-media.ts'
import { WS_AUTH_PROTOCOL_PREFIX } from '@shared/tauri/ws-protocol.ts'

export interface WsEndpoint {
  port: number
  token: string
}

let endpointPromise: Promise<WsEndpoint> | null = null

export function wsEndpointReady(): Promise<WsEndpoint> {
  endpointPromise ??= start()
  return endpointPromise
}

/**
 * Inbound channel allowlists, generated from the preload contract at bundle
 * time (scripts/build-tauri.mts). Under Electron the renderer can only reach
 * channels the preload exposes; here any page script could open its own
 * socket, so the server enforces the same surface — an invoke/send outside it
 * closes the connection instead of reaching the ipcMain handler table.
 * Outside the sidecar bundle the defines are absent and this fails closed.
 */
const allowedInvokeChannels: ReadonlySet<string> = new Set(
  typeof __COPSE_WS_INVOKE_CHANNELS__ === 'undefined' ? [] : __COPSE_WS_INVOKE_CHANNELS__,
)
const allowedSendChannels: ReadonlySet<string> = new Set(
  typeof __COPSE_WS_SEND_CHANNELS__ === 'undefined' ? [] : __COPSE_WS_SEND_CHANNELS__,
)

/**
 * The frame bound must admit the largest legitimate invoke: a dropped video
 * attachment (`MAX_VIDEO_BYTES`, the biggest of the documented attachment
 * limits) rides base64-encoded inside a JSON frame (×4/3), plus marker and
 * framing overhead. Deriving it from the product limit keeps the transport
 * and the attachment contract from drifting apart. Peers that cannot present
 * the token never reach frame buffering at all — authentication happens at
 * the HTTP upgrade below — so this bound is defense-in-depth on
 * authenticated traffic, not the pre-auth gate.
 */
const MAX_FRAME_BYTES = Math.ceil((MAX_VIDEO_BYTES * 4) / 3) + 64 * 1024

function start(): Promise<WsEndpoint> {
  const token = randomBytes(32).toString('hex')
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    maxPayload: MAX_FRAME_BYTES,
    // Authentication starts at the HTTP upgrade, before any WS frame can be
    // buffered: the browser WebSocket API cannot set request headers, so the
    // bearer token rides the subprotocol list. `verifyClient` is the actual
    // gate — it sees the raw header, including its absence (`handleProtocols`
    // is never consulted for a client that offers no subprotocols, so it
    // cannot refuse one). A request without the exact token protocol is
    // rejected at the handshake; an unauthenticated local peer never gets a
    // connection to feed frames (of any size) into. The hello frame then
    // re-checks the token and binds the window id.
    verifyClient: (info: {
      req: { headers: Record<string, string | string[] | undefined> }
    }): boolean => {
      const header = info.req.headers['sec-websocket-protocol']
      if (typeof header !== 'string') return false
      return header
        .split(',')
        .map((protocol) => protocol.trim())
        .includes(`${WS_AUTH_PROTOCOL_PREFIX}${token}`)
    },
    // Echo the token protocol back so the client's handshake validation
    // (which requires the server to select an offered protocol) succeeds.
    handleProtocols: (protocols): string | false => {
      const expected = `${WS_AUTH_PROTOCOL_PREFIX}${token}`
      return protocols.has(expected) ? expected : false
    },
  })

  server.on('connection', (socket) => {
    let bound: { winId: number; unbind: () => void } | null = null
    // ws surfaces protocol violations (an over-`maxPayload` frame among them)
    // as an 'error' event before closing the socket; without a listener that
    // event throws and takes the whole sidecar down. The socket is already
    // being closed (1009 for oversize) — just keep the process alive.
    socket.on('error', (error) => {
      console.error('[ws-server] socket error:', error.message)
    })
    // A client that never authenticates gets dropped; nothing before a valid
    // hello is dispatched anywhere.
    const helloTimeout = setTimeout(() => {
      if (!bound) socket.close(4001, 'no hello')
    }, 5000)

    const reply = (frame: ServerFrame): void => {
      if (socket.readyState === socket.OPEN) socket.send(encodeFrame(frame))
    }

    socket.on('message', (data) => {
      let frame: ClientFrame
      try {
        frame = decodeClientFrame(
          typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : '',
        )
      } catch {
        socket.close(4002, 'bad frame')
        return
      }

      if (frame.t === 'hello') {
        if (bound) {
          socket.close(4006, 'already authenticated')
          return
        }
        if (frame.token !== token) {
          socket.close(4003, 'bad token')
          return
        }
        try {
          const unbind = sidecarInternals.bindClient(frame.winId, (channel, args) => {
            reply({ t: 'event', channel, args })
          })
          bound = { winId: frame.winId, unbind }
          clearTimeout(helloTimeout)
          reply({ t: 'hello-ok' })
        } catch (error) {
          console.error('[ws-server] hello rejected:', error)
          socket.close(4004, 'unknown window')
        }
        return
      }

      if (!bound) {
        socket.close(4005, 'not authenticated')
        return
      }

      if (frame.t === 'invoke') {
        const { id, channel, args } = frame
        if (!allowedInvokeChannels.has(channel)) {
          socket.close(4007, 'channel not allowed')
          return
        }
        sidecarInternals.dispatchInvoke(bound.winId, channel, args).then(
          (value) => {
            reply({ t: 'result', id, ok: true, value })
          },
          (error: unknown) => {
            reply({
              t: 'result',
              id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
          },
        )
        return
      }

      // Only 'send' remains after the returns above.
      if (!allowedSendChannels.has(frame.channel)) {
        socket.close(4007, 'channel not allowed')
        return
      }
      sidecarInternals.dispatchSend(bound.winId, frame.channel, frame.args)
    })

    socket.on('close', () => {
      clearTimeout(helloTimeout)
      bound?.unbind()
      bound = null
    })
  })

  return new Promise<WsEndpoint>((resolve, reject) => {
    server.once('listening', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('ws server bound to a pipe?'))
        return
      }
      const endpoint = { port: address.port, token }
      // Headless smoke tests (no Tauri shell, no boot URL to read the endpoint
      // from) discover the server through this file instead.
      const endpointFile = process.env['COPSE_SIDECAR_ENDPOINT_FILE']
      if (endpointFile) {
        writeFileSync(endpointFile, JSON.stringify(endpoint))
      }
      console.error(`[ws-server] listening on 127.0.0.1:${String(endpoint.port)}`)
      resolve(endpoint)
    })
    server.once('error', reject)
  })
}

/** Exposed for the smoke test: window ids currently known to the shim. */
export function listWindowIds(): number[] {
  return sidecarInternals.listWindowIds()
}
