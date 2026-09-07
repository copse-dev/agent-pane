/**
 * The guest side of egress (`docs/plans/thread-in-container.md`, decision A2).
 *
 * An HTTP proxy on loopback inside the container. Every client in the guest —
 * the worker's own SDK calls under `NODE_USE_ENV_PROXY=1`, and any child that
 * honours `HTTPS_PROXY` (git, curl, an agent CLI) — reaches the outside only
 * through it. For each request it opens one stream on the link to the host
 * (`egress-link.ts`, frames over the container's stdio), naming `host:port`,
 * and waits for the host's answer: the host decides, the guest only asks.
 *
 * Two request shapes, because that is what clients send to a proxy:
 *
 * - `CONNECT host:port` for HTTPS. Reply `200`, then pipe bytes both ways; TLS
 *   is between the client and the origin.
 * - An absolute-form request (`GET http://host:port/path`) for plain HTTP —
 *   an OpenAI-compatible server on the host's loopback, typically. Rewritten
 *   to origin-form with `Connection: close`, forwarded over the tunnel, and the
 *   response streamed back raw so server-sent events arrive as they are sent.
 *
 * Deliberately dependency-free: it lives in the worker bundle and must not
 * widen what the image carries.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { EgressLink } from './egress-link.ts'
import { guestEgressAuthorization, parseEgressTarget } from './egress-rules.ts'

export interface GuestEgressProxyAddress {
  host: string
  port: number
}

export interface GuestEgressProxy {
  address: GuestEgressProxyAddress
  close: () => Promise<void>
}

export interface GuestEgressProxyOptions {
  /**
   * Per-run token every request must carry as `Proxy-Authorization` (decision
   * A7). The worker's own client and the agent are given it through their
   * proxy URL; a shell child in the guest is not, so the network it can see
   * is the proxy's 407 and nothing behind it. Absent = no check (tests).
   */
  token?: string
  /** Told about every request refused for want of the token. */
  onRefused?: (target: string) => void
  /**
   * Told about every tunnel the broker would not or could not open, with the
   * reason the client was given in its 403: the broker's `DENY`, or the
   * failure to reach the broker at all.
   */
  onTunnelError?: (target: string, reason: string) => void
}

/**
 * Ask the broker whether it is there: one round trip on the link. Rejects
 * with what went wrong so the worker can name the fault before any client
 * trips over it.
 */
export function probeBroker(link: EgressLink, timeoutMs = 5000): Promise<void> {
  return link.ping(timeoutMs)
}

const PROXY_AUTH_REQUIRED =
  'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="copse-run"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'

/** Headers that belong to the hop between client and proxy, not to the origin. */
const HOP_BY_HOP = new Set([
  'proxy-connection',
  'proxy-authorization',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
])

/** Open a stream to `host:port` on the link; resolves once the host has accepted. */
function openTunnel(link: EgressLink, host: string, port: number): Promise<Duplex> {
  return link.open(`${host}:${String(port)}`)
}

function targetOf(request: IncomingMessage): { host: string; port: number; path: string } | null {
  const url = request.url ?? ''
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  const target = parseEgressTarget(`${parsed.hostname}:${String(port)}`)
  if (target === null) return null
  return { ...target, path: `${parsed.pathname}${parsed.search}` }
}

function pipeBoth(a: Duplex, b: Duplex): void {
  a.pipe(b)
  b.pipe(a)
  const drop = (): void => {
    a.destroy()
    b.destroy()
  }
  a.on('error', drop)
  b.on('error', drop)
  a.on('close', drop)
  b.on('close', drop)
}

/**
 * Start the proxy. `port: 0` binds an ephemeral port (tests); the worker uses
 * the fixed `GUEST_EGRESS_PROXY` address the container's env already names.
 */
export function startGuestEgressProxy(
  link: EgressLink,
  listen: GuestEgressProxyAddress,
  options: GuestEgressProxyOptions = {},
): Promise<GuestEgressProxy> {
  const server: Server = createHttpServer()
  const expected = options.token === undefined ? null : guestEgressAuthorization(options.token)
  const authorised = (request: IncomingMessage): boolean =>
    expected === null || request.headers['proxy-authorization'] === expected

  // HTTPS: CONNECT, then a raw tunnel.
  server.on('connect', (request, client: Socket, head: Buffer) => {
    if (!authorised(request)) {
      options.onRefused?.(request.url ?? '')
      client.end(PROXY_AUTH_REQUIRED)
      return
    }
    const target = parseEgressTarget(request.url ?? '')
    if (target === null) {
      client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      return
    }
    openTunnel(link, target.host, target.port).then(
      (tunnel) => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) tunnel.write(head)
        pipeBoth(client, tunnel)
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        options.onTunnelError?.(`${target.host}:${String(target.port)}`, message)
        client.end(
          `HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${message}\n`,
        )
      },
    )
  })

  // Plain HTTP: absolute-form request, rewritten to origin-form over the tunnel.
  server.on('request', (request, response) => {
    if (!authorised(request)) {
      options.onRefused?.(request.url ?? '')
      response.writeHead(407, {
        'Proxy-Authenticate': 'Basic realm="copse-run"',
        Connection: 'close',
      })
      response.end()
      return
    }
    const target = targetOf(request)
    if (target === null) {
      response.writeHead(400, { Connection: 'close' })
      response.end('proxy requests must be absolute-form\n')
      return
    }
    const client = request.socket
    openTunnel(link, target.host, target.port).then(
      (tunnel) => {
        // The head, rebuilt: origin-form path, hop-by-hop headers dropped, one
        // response per connection so the origin closes when it is done.
        const lines = [`${request.method ?? 'GET'} ${target.path} HTTP/1.1`]
        let chunked = false
        for (let i = 0; i < request.rawHeaders.length; i += 2) {
          const name = request.rawHeaders[i] ?? ''
          const value = request.rawHeaders[i + 1] ?? ''
          const lower = name.toLowerCase()
          if (HOP_BY_HOP.has(lower)) continue
          if (lower === 'transfer-encoding') {
            chunked = /chunked/i.test(value)
            continue
          }
          lines.push(`${name}: ${value}`)
        }
        lines.push('Connection: close')
        if (chunked) lines.push('Transfer-Encoding: chunked')
        tunnel.write(`${lines.join('\r\n')}\r\n\r\n`)
        // Node has de-chunked the body; re-chunk when the origin was told to
        // expect it, otherwise the Content-Length it was given still holds.
        request.on('data', (chunk: Buffer) => {
          if (chunked) tunnel.write(`${chunk.length.toString(16)}\r\n`)
          tunnel.write(chunk)
          if (chunked) tunnel.write('\r\n')
        })
        request.on('end', () => {
          if (chunked) tunnel.write('0\r\n\r\n')
        })
        // The response goes back on the raw socket; the origin's own status
        // line and headers are what the client should see.
        response.detachSocket(client)
        tunnel.pipe(client)
        const drop = (): void => {
          tunnel.destroy()
          client.destroy()
        }
        tunnel.on('error', drop)
        client.on('error', drop)
        tunnel.on('end', () => {
          client.end()
        })
        client.on('close', () => {
          tunnel.destroy()
        })
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        options.onTunnelError?.(`${target.host}:${String(target.port)}`, message)
        response.writeHead(403, { Connection: 'close', 'Content-Type': 'text/plain' })
        response.end(`${message}\n`)
      },
    )
  })

  return new Promise((resolveStart, reject) => {
    server.once('error', reject)
    server.listen(listen.port, listen.host, () => {
      server.off('error', reject)
      const bound = server.address()
      const port = typeof bound === 'object' && bound !== null ? bound.port : listen.port
      resolveStart({
        address: { host: listen.host, port },
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => {
              resolveClose()
            })
            server.closeAllConnections()
          }),
      })
    })
  })
}
