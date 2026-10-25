import { request as httpRequest, type ClientRequestArgs } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { BlockList, connect as netConnect, isIP, Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { connect as tlsConnect } from 'node:tls'

/**
 * Outbound connections for the package firewall that honour the user's own
 * proxy settings. The firewall replaces `HTTPS_PROXY` in its child's
 * environment with itself, so it must chain to whatever proxy the user had —
 * a corporate egress proxy keeps working with the firewall in front of it.
 */

export interface UpstreamConfig {
  /** The user's HTTP(S) proxy for outbound HTTPS, or null to connect directly. */
  proxy: URL | null
  /** `NO_PROXY` entries; a matching host bypasses `proxy`. */
  noProxy: readonly string[]
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

export function parseNoProxy(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
}

/** The proxy a curl-style client would use for an `https://` URL in `env`. */
export function upstreamConfigFromEnv(env: NodeJS.ProcessEnv): UpstreamConfig {
  const raw =
    nonEmpty(env['HTTPS_PROXY']) ??
    nonEmpty(env['https_proxy']) ??
    nonEmpty(env['ALL_PROXY']) ??
    nonEmpty(env['all_proxy'])
  let proxy: URL | null = null
  if (raw) {
    try {
      const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`)
      // A SOCKS proxy cannot carry CONNECT; connect directly rather than fail.
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') proxy = parsed
    } catch {
      proxy = null
    }
  }
  return { proxy, noProxy: parseNoProxy(env['NO_PROXY'] ?? env['no_proxy']) }
}

function bareHost(host: string): string {
  return host.toLowerCase().replace(/^\[(.*)\]$/, '$1')
}

/** curl's `NO_PROXY` semantics, plus IPv4/IPv6 CIDR entries for IP literals. */
export function hostBypassesProxy(host: string, port: number, noProxy: readonly string[]): boolean {
  const target = bareHost(host)
  const family = isIP(target)
  return noProxy.some((raw) => {
    if (raw === '*') return true
    let entry = raw
    const withPort = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(entry)
    if (withPort) {
      if (Number(withPort[2]) !== port) return false
      entry = withPort[1] ?? entry
    }
    entry = bareHost(entry).replace(/^\*?\./, '')
    const cidr = /^(.+)\/(\d{1,3})$/.exec(entry)
    if (cidr) {
      const network = cidr[1] ?? ''
      const networkFamily = isIP(network)
      if (family === 0 || networkFamily !== family) return false
      const list = new BlockList()
      const type = family === 4 ? 'ipv4' : 'ipv6'
      list.addSubnet(network, Number(cidr[2]), type)
      return list.check(target, type)
    }
    return target === entry || (family === 0 && target.endsWith(`.${entry}`))
  })
}

function connectDirect(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: bareHost(host), port })
    socket.setTimeout(timeoutMs, () => {
      socket.destroy(new Error(`Timed out connecting to ${host}:${String(port)}`))
    })
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.setTimeout(0)
      socket.off('error', reject)
      resolve(socket)
    })
  })
}

function connectThroughProxy(
  host: string,
  port: number,
  proxy: URL,
  timeoutMs: number,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const target = bareHost(host)
    const authority = `${isIP(target) === 6 ? `[${target}]` : target}:${String(port)}`
    const headers: Record<string, string> = { host: authority }
    if (proxy.username) {
      const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
      headers['proxy-authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`
    }
    const secure = proxy.protocol === 'https:'
    const request = (secure ? httpsRequest : httpRequest)({
      host: bareHost(proxy.hostname),
      port: proxy.port ? Number(proxy.port) : secure ? 443 : 80,
      method: 'CONNECT',
      path: authority,
      headers,
      agent: false,
      timeout: timeoutMs,
    })
    request.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(
          new Error(`Upstream proxy refused CONNECT ${authority} (${String(response.statusCode)})`),
        )
        return
      }
      if (head.length > 0) socket.unshift(head)
      resolve(socket)
    })
    request.once('timeout', () => {
      request.destroy(new Error(`Timed out reaching the upstream proxy for ${authority}`))
    })
    request.once('error', reject)
    request.end()
  })
}

/** A raw TCP stream to `host:port`, through the user's proxy unless `NO_PROXY` says otherwise. */
export function connectUpstream(
  host: string,
  port: number,
  config: UpstreamConfig,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<Socket> {
  if (!config.proxy || hostBypassesProxy(host, port, config.noProxy)) {
    return connectDirect(host, port, timeoutMs)
  }
  return connectThroughProxy(host, port, config.proxy, timeoutMs)
}

/**
 * Keep-alive HTTPS agent whose sockets come from {@link connectUpstream}. TLS is
 * verified against the process's normal trust store (Node's bundled roots plus
 * `NODE_EXTRA_CA_CERTS`), never the firewall's own CA.
 */
export class UpstreamHttpsAgent extends HttpsAgent {
  readonly #upstream: UpstreamConfig

  constructor(upstream: UpstreamConfig) {
    super({ keepAlive: true, maxSockets: 32 })
    this.#upstream = upstream
  }

  override createConnection(
    options: ClientRequestArgs,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const host = bareHost(options.hostname ?? options.host ?? '')
    const port = Number(options.port ?? 443)
    connectUpstream(host, port, this.#upstream).then(
      (raw) => {
        const secure = tlsConnect({
          socket: raw,
          ...(isIP(host) === 0 ? { servername: host } : {}),
          ALPNProtocols: ['http/1.1'],
        })
        callback?.(null, secure)
      },
      (error: unknown) => {
        // Node ignores the stream when an error is reported; hand it a dead one.
        const unused = new Socket()
        unused.destroy()
        callback?.(error instanceof Error ? error : new Error(String(error)), unused)
      },
    )
    return undefined
  }
}

export interface UpstreamRequest {
  method?: 'GET' | 'POST'
  body?: string
  headers?: Record<string, string>
  timeoutMs: number
  maxBytes: number
}

/** One buffered HTTPS request through `agent`. Rejects on a non-2xx status or an oversized body. */
export function fetchUpstreamText(
  url: string,
  init: UpstreamRequest,
  agent: HttpsAgent,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method: init.method ?? 'GET',
      agent,
      timeout: init.timeoutMs,
      headers: {
        'user-agent': 'copse-package-firewall',
        ...(init.body === undefined ? {} : { 'content-length': Buffer.byteLength(init.body) }),
        ...init.headers,
      },
    })
    request.once('timeout', () => {
      request.destroy(new Error(`Timed out fetching ${url}`))
    })
    request.once('error', reject)
    request.once('response', (response) => {
      const status = response.statusCode ?? 0
      if (status < 200 || status >= 300) {
        response.resume()
        reject(new Error(`${url} answered ${String(status)}`))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > init.maxBytes) {
          request.destroy(new Error(`${url} exceeded ${String(init.maxBytes)} bytes`))
          return
        }
        chunks.push(chunk)
      })
      response.once('error', reject)
      response.once('end', () => {
        resolve(Buffer.concat(chunks).toString('utf8'))
      })
    })
    request.end(init.body)
  })
}
