/**
 * The guest side of the GitHub read capability (`docs/plans/thread-in-container.md`,
 * decision A24).
 *
 * Two listeners with one handler: a unix socket that `gh` is pointed at by its
 * `http_unix_socket` setting, and a loopback HTTP proxy that `git` is pointed
 * at for the synthetic `http://github.copse.internal/` its `insteadOf` rewrites
 * github.com to. Every request either receives becomes one stream on the link
 * to the host, opened for {@link HOST_GITHUB_TARGET}: the request as received
 * (method, request-target, headers) as a JSON head line, then the body. The
 * host decides and answers with a head line and the body, which is written
 * back to the client as it arrives.
 *
 * The bridge decides nothing and holds no credential; the host owns policy
 * and the token. It is reachable by every process in the guest, deliberately:
 * the shell's `gh` and `git` are the clients it exists for.
 *
 * Dependency-free beyond the wire module: it lives in the worker bundle.
 */
import { chmodSync, existsSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import type { EgressLink } from './egress-link.ts'
import {
  encodeHead,
  githubResponseHeadSchema,
  HeadReader,
  HOST_GITHUB_TARGET,
} from './github-capability-wire.ts'

export interface GuestGitHubBridge {
  socketPath: string
  gitProxyPort: number
  close: () => Promise<void>
}

function sendError(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) {
    response.destroy()
    return
  }
  const body = `${JSON.stringify({ message })}\n`
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    Connection: 'close',
  })
  response.end(body)
}

function headersOf(request: IncomingMessage): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    pairs.push([request.rawHeaders[i] ?? '', request.rawHeaders[i + 1] ?? ''])
  }
  return pairs
}

/** Relay one request over a fresh stream on the link. */
function relay(
  link: EgressLink,
  request: IncomingMessage,
  response: ServerResponse,
  held: Set<Duplex>,
): void {
  link.open(HOST_GITHUB_TARGET).then(
    (tunnel) => {
      held.add(tunnel)
      tunnel.once('close', () => {
        held.delete(tunnel)
      })
      tunnel.write(
        encodeHead({
          method: request.method ?? 'GET',
          target: request.url ?? '/',
          headers: headersOf(request),
        }),
      )
      // Node has de-chunked the body; the host gets the bytes and the
      // original headers, and frames the upstream request itself.
      request.pipe(tunnel)
      const reader = new HeadReader()
      let started = false
      tunnel.on('data', (chunk: Buffer) => {
        if (started) {
          if (!response.write(chunk)) {
            tunnel.pause()
            response.once('drain', () => {
              tunnel.resume()
            })
          }
          return
        }
        let found: { line: string; rest: Buffer } | null
        try {
          found = reader.feed(chunk)
        } catch {
          sendError(response, 502, 'Copse: the host sent a malformed answer.')
          tunnel.destroy()
          return
        }
        if (found === null) return
        const head = safeJsonParse(found.line, decodeWithSchema(githubResponseHeadSchema))
        if (head === null) {
          sendError(response, 502, 'Copse: the host sent a malformed answer.')
          tunnel.destroy()
          return
        }
        started = true
        const headers: Array<[string, string]> = head.headers
        response.writeHead(head.status, headers.flat())
        if (found.rest.length > 0) response.write(found.rest)
      })
      tunnel.on('end', () => {
        if (!started) sendError(response, 502, 'Copse: the host closed the request.')
        else response.end()
      })
      tunnel.on('error', () => {
        sendError(response, 502, 'Copse: the request to the host failed.')
      })
      response.on('close', () => {
        if (!tunnel.destroyed) tunnel.destroy()
      })
    },
    (error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error)
      sendError(response, 502, `Copse: GitHub is not available to this run (${reason}).`)
    },
  )
}

function listen(server: Server, target: string | { host: string; port: number }): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject)
    const done = (): void => {
      server.off('error', reject)
      resolveListen()
    }
    if (typeof target === 'string') server.listen(target, done)
    else server.listen(target.port, target.host, done)
  })
}

/** Start both listeners; `gitProxy.port: 0` binds an ephemeral port. */
export async function startGuestGitHubBridge(
  link: EgressLink,
  options: { socketPath: string; gitProxy: { host: string; port: number } },
): Promise<GuestGitHubBridge> {
  const held = new Set<Duplex>()
  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    relay(link, request, response, held)
  }
  const refuseConnect = (_request: IncomingMessage, socket: Socket): void => {
    socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  }
  const socketServer = createServer(handle)
  const proxyServer = createServer(handle)
  for (const server of [socketServer, proxyServer]) {
    server.on('connect', refuseConnect)
    server.on('clientError', (_error, socket) => {
      socket.destroy()
    })
  }
  if (existsSync(options.socketPath)) rmSync(options.socketPath, { force: true })
  await listen(socketServer, options.socketPath)
  // Same uid only: the guest runs everything as the worker user.
  chmodSync(options.socketPath, 0o600)
  await listen(proxyServer, options.gitProxy)
  const bound = proxyServer.address()
  const gitProxyPort = typeof bound === 'object' && bound !== null ? bound.port : 0
  const closeServer = (server: Server): Promise<void> =>
    new Promise((resolveClose) => {
      server.close(() => {
        resolveClose()
      })
      server.closeAllConnections()
    })
  return {
    socketPath: options.socketPath,
    gitProxyPort,
    close: async (): Promise<void> => {
      for (const tunnel of held) tunnel.destroy()
      await Promise.all([closeServer(socketServer), closeServer(proxyServer)])
      rmSync(options.socketPath, { force: true })
    },
  }
}
