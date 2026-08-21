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

export interface WsEndpoint {
  port: number
  token: string
}

let endpointPromise: Promise<WsEndpoint> | null = null

export function wsEndpointReady(): Promise<WsEndpoint> {
  endpointPromise ??= start()
  return endpointPromise
}

function start(): Promise<WsEndpoint> {
  const token = randomBytes(32).toString('hex')
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })

  server.on('connection', (socket) => {
    let bound: { winId: number; unbind: () => void } | null = null
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
