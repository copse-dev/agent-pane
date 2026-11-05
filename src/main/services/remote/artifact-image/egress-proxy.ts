/**
 * The one egress route for a confined artifact-image download.
 *
 * ASRT points the downloader's only network path at this proxy (both its HTTP
 * and SOCKS ports). The proxy is the policy point, not a relay: it accepts only
 * an authenticated `CONNECT <approved-host>:443`, resolves the host once,
 * refuses the destination if any answer is non-public, and dials the vetted
 * numeric address directly, so a second DNS lookup cannot rebind it. TLS stays
 * end-to-end between the downloader and the origin; the proxy never sees
 * plaintext and never terminates TLS.
 */
import { lookup } from 'node:dns/promises'
import { connect as netConnect, createServer, isIP, type Server, type Socket } from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import { isPublicAddress, MAX_ARTIFACT_IMAGE_REDIRECTS } from './policy.ts'

const MAX_CONNECT_HEADER_BYTES = 8 * 1024
const CONNECT_HEADER_TIMEOUT_MS = 10_000
const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000
export const EGRESS_PROXY_USER = 'copse'

export type EgressDecision =
  | { outcome: 'allowed'; host: string }
  | {
      outcome:
        | 'unauthenticated'
        | 'method'
        | 'authority'
        | 'host-denied'
        | 'non-public'
        | 'unresolved'
        | 'tunnel-limit'
        | 'malformed'
        | 'upstream-failed'
      host?: string
    }

export interface EgressProxyOptions {
  token: string
  /** Exact lowercase hostnames; port 443 is implied and the only one allowed. */
  allowedHosts: readonly string[]
  /** Every address for `host`. Injected for tests; the default asks the OS once. */
  resolve?: (host: string) => Promise<string[]>
  /** Dial a vetted numeric address. Injected for tests. */
  connect?: (address: string, port: number) => Socket
  /** A job needs one tunnel per request: the first plus each redirect. */
  maxTunnels?: number
  headerTimeoutMs?: number
  onDecision?: (decision: EgressDecision) => void
}

export interface EgressProxy {
  port: number
  close(): Promise<void>
}

async function resolveAll(host: string): Promise<string[]> {
  const answers = await lookup(host, { all: true, verbatim: true })
  return answers.map((answer) => answer.address)
}

function reply(socket: Socket, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
}

/** `Basic base64(copse:<token>)`, compared in constant time. */
function authorized(header: string | undefined, token: string): boolean {
  if (!header) return false
  const match = /^Basic ([A-Za-z0-9+/]+=*)$/u.exec(header.trim())
  if (!match?.[1]) return false
  const presented = Buffer.from(match[1], 'base64')
  const expected = Buffer.from(`${EGRESS_PROXY_USER}:${token}`, 'utf8')
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

interface ConnectRequest {
  method: string
  authority: string
  headers: Map<string, string>
}

function parseConnectHead(head: string): ConnectRequest | null {
  const lines = head.split('\r\n')
  const requestLine = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/u.exec(lines[0] ?? '')
  if (!requestLine?.[1] || !requestLine[2]) return null
  const headers = new Map<string, string>()
  for (const line of lines.slice(1)) {
    if (line === '') continue
    const colon = line.indexOf(':')
    if (colon <= 0) return null
    const name = line.slice(0, colon).trim().toLowerCase()
    // A repeated header is ambiguous; refuse rather than pick one.
    if (headers.has(name)) return null
    headers.set(name, line.slice(colon + 1).trim())
  }
  return { method: requestLine[1], authority: requestLine[2], headers }
}

/** `host:443` with a plain DNS name; IP literals and other ports are refused. */
function parseAuthority(authority: string): string | null {
  const match =
    /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+):443$/u.exec(authority)
  const host = match?.[1]
  if (!host || isIP(host) !== 0) return null
  return host
}

export function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const allowed = new Set(options.allowedHosts)
  const resolve = options.resolve ?? resolveAll
  const connect =
    options.connect ??
    ((address: string, port: number): Socket => netConnect({ host: address, port }))
  const maxTunnels = options.maxTunnels ?? MAX_ARTIFACT_IMAGE_REDIRECTS + 1
  const headerTimeoutMs = options.headerTimeoutMs ?? CONNECT_HEADER_TIMEOUT_MS
  const decide = (decision: EgressDecision): void => {
    options.onDecision?.(decision)
  }
  const sockets = new Set<Socket>()
  let tunnels = 0

  const handle = (client: Socket): void => {
    sockets.add(client)
    client.once('close', () => sockets.delete(client))
    client.on('error', () => {
      client.destroy()
    })
    let buffered = Buffer.alloc(0)
    const timer = setTimeout(() => {
      decide({ outcome: 'malformed' })
      client.destroy()
    }, headerTimeoutMs)
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf('\r\n\r\n')
      if (end === -1) {
        if (buffered.length > MAX_CONNECT_HEADER_BYTES) {
          clearTimeout(timer)
          client.off('data', onData)
          decide({ outcome: 'malformed' })
          reply(client, '431 Request Header Fields Too Large')
        }
        return
      }
      clearTimeout(timer)
      client.off('data', onData)
      // A client must wait for 200 before sending tunnel bytes.
      if (end + 4 !== buffered.length || end > MAX_CONNECT_HEADER_BYTES) {
        decide({ outcome: 'malformed' })
        reply(client, '400 Bad Request')
        return
      }
      void route(client, buffered.subarray(0, end).toString('latin1'))
    }
    client.on('data', onData)
  }

  const route = async (client: Socket, head: string): Promise<void> => {
    const request = parseConnectHead(head)
    if (!request) {
      decide({ outcome: 'malformed' })
      reply(client, '400 Bad Request')
      return
    }
    // Authenticate before revealing anything about the policy.
    if (!authorized(request.headers.get('proxy-authorization'), options.token)) {
      decide({ outcome: 'unauthenticated' })
      reply(client, '407 Proxy Authentication Required')
      return
    }
    if (request.method !== 'CONNECT') {
      decide({ outcome: 'method' })
      reply(client, '405 Method Not Allowed')
      return
    }
    const host = parseAuthority(request.authority)
    if (!host) {
      decide({ outcome: 'authority' })
      reply(client, '403 Forbidden')
      return
    }
    if (!allowed.has(host)) {
      decide({ outcome: 'host-denied', host })
      reply(client, '403 Forbidden')
      return
    }
    if (tunnels >= maxTunnels) {
      decide({ outcome: 'tunnel-limit', host })
      reply(client, '429 Too Many Requests')
      return
    }
    tunnels++
    let addresses: string[]
    try {
      addresses = await resolve(host)
    } catch {
      addresses = []
    }
    if (addresses.length === 0) {
      decide({ outcome: 'unresolved', host })
      reply(client, '502 Bad Gateway')
      return
    }
    // One private answer poisons the whole set: a client cannot be trusted
    // to pick the public one, and neither can a later lookup.
    if (!addresses.every(isPublicAddress)) {
      decide({ outcome: 'non-public', host })
      reply(client, '403 Forbidden')
      return
    }
    const address = addresses[0]
    if (!address || client.destroyed) return
    const upstream = connect(address, 443)
    sockets.add(upstream)
    upstream.once('close', () => sockets.delete(upstream))
    const connectTimer = setTimeout(() => {
      upstream.destroy(new Error('upstream connect timeout'))
    }, UPSTREAM_CONNECT_TIMEOUT_MS)
    upstream.once('error', () => {
      clearTimeout(connectTimer)
      decide({ outcome: 'upstream-failed', host })
      if (!client.destroyed) reply(client, '502 Bad Gateway')
      upstream.destroy()
    })
    upstream.once('connect', () => {
      clearTimeout(connectTimer)
      if (client.destroyed) {
        upstream.destroy()
        return
      }
      decide({ outcome: 'allowed', host })
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.removeAllListeners('error')
      upstream.on('error', () => client.destroy())
      client.on('close', () => upstream.destroy())
      upstream.on('close', () => client.destroy())
      client.pipe(upstream)
      upstream.pipe(client)
    })
  }

  const server: Server = createServer(handle)
  return new Promise((resolveStart, rejectStart) => {
    server.once('error', rejectStart)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectStart)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        rejectStart(new Error('egress proxy did not bind a TCP port'))
        return
      }
      resolveStart({
        port: address.port,
        close: () =>
          new Promise<void>((resolveClose) => {
            for (const socket of sockets) socket.destroy()
            server.close(() => {
              resolveClose()
            })
          }),
      })
    })
  })
}
