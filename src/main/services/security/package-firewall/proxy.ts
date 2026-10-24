import { timingSafeEqual } from 'node:crypto'
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http'
import { request as httpsRequest, type Agent as HttpsAgent } from 'node:https'
import type { AddressInfo, Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { createSecureContext, TLSSocket, type SecureContext } from 'node:tls'
import { createGunzip } from 'node:zlib'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import type { PackageVerdict } from './advisories.ts'
import {
  formatPackage,
  interceptedEcosystem,
  metadataForRequest,
  packageForDownload,
  type MetadataTarget,
  type PackageCoordinates,
} from './registry-targets.ts'
import { hideRecentVersions } from './release-age.ts'
import type { CertificateAuthority } from './x509.ts'

/**
 * The package firewall's local proxy.
 *
 * Children reach it through `HTTPS_PROXY`. A CONNECT to a registry host is
 * answered locally: TLS is terminated with a certificate from the invocation's
 * name-constrained CA, each request's download is checked, and allowed requests
 * are forwarded to the real registry over a separately verified TLS connection.
 * With a release-age limit, package metadata is fetched whole and served with
 * versions younger than the limit left out (`release-age.ts`).
 * A CONNECT to any other host becomes a plain TCP tunnel — the firewall never
 * sees, or can alter, those bytes.
 *
 * Every request must carry the invocation's credentials. The proxy listens on
 * loopback, which sandboxed agents may be allowed to reach; without the token it
 * would be an egress path around their network policy.
 */

export const PROXY_USER = 'copse'
const REALM = 'copse-package-firewall'

export interface FirewallDecision {
  pkg: PackageCoordinates
  verdict: PackageVerdict
}

export interface PackageFirewallProxyOptions {
  authority: CertificateAuthority
  token: string
  check: (pkg: PackageCoordinates) => Promise<PackageVerdict>
  /** Raw TCP connection for a CONNECT target the firewall does not inspect. */
  connectTunnel: (host: string, port: number) => Promise<Socket>
  /** Agent that forwards inspected requests to the real registry. */
  registryAgent: HttpsAgent
  onDecision?: (decision: FirewallDecision) => void
  /** A registry or tunnelled host could not be reached (e.g. no network inside a sandbox). */
  onUnreachable?: (host: string, error: Error) => void
  /** Leave versions younger than `minAgeMs` out of package metadata. Absent: metadata passes through. */
  releaseAge?: { minAgeMs: number; now?: () => number }
  /** Versions left out of one metadata response, newest first. */
  onRecentVersions?: (target: MetadataTarget, hidden: readonly string[]) => void
}

export interface RunningFirewallProxy {
  port: number
  /** `http://copse:<token>@127.0.0.1:<port>`, for the child's proxy variables. */
  url: string
  close(): Promise<void>
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Copy end-to-end headers only (RFC 9110 §7.6.1). */
function endToEndHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const connection = headers['connection']
  const listed = new Set(
    (typeof connection === 'string' ? connection : '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  )
  const out: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || listed.has(name)) continue
    out[name] = value
  }
  return out
}

function parseAuthority(authority: string): { host: string; port: number } | null {
  const match = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(authority)
  const port = Number(match?.[2])
  if (!match?.[1] || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host: match[1].toLowerCase(), port }
}

export function blockedMessage(pkg: PackageCoordinates, verdict: PackageVerdict): string {
  return (
    `Blocked ${pkg.ecosystem} package ${formatPackage(pkg)}: ` +
    `listed as malicious by ${verdict.advisories.join(', ')}`
  )
}

function respondBlocked(
  response: ServerResponse,
  pkg: PackageCoordinates,
  verdict: PackageVerdict,
): void {
  const body = JSON.stringify({ error: blockedMessage(pkg, verdict) })
  response.writeHead(403, 'Blocked: listed as malicious', {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    connection: 'close',
  })
  response.end(body)
}

function respondPlain(response: ServerResponse, status: number, text: string): void {
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(status, {
    'content-type': 'text/plain',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

/** A metadata document larger than this is relayed as is: no registry serves one. */
const METADATA_MAX_BYTES = 256 * 1024 * 1024
const METADATA_TIMEOUT_MS = 120_000

/** Request headers that would let the registry answer 304 or a partial body. */
const CONDITIONAL_HEADERS: ReadonlySet<string> = new Set([
  'if-none-match',
  'if-modified-since',
  'if-match',
  'if-unmodified-since',
  'if-range',
  'range',
])

/** Response headers that describe the registry's encoding of the body, not the decoded one served. */
const ENCODING_HEADERS: ReadonlySet<string> = new Set(['content-encoding', 'content-length'])

/** Response headers that would let a cache keep or revalidate a rewritten document. */
const CACHE_HEADERS: ReadonlySet<string> = new Set([
  'content-encoding',
  'content-length',
  'etag',
  'last-modified',
  'expires',
  'age',
  'cache-control',
])

function withoutHeaders(
  headers: OutgoingHttpHeaders,
  names: ReadonlySet<string>,
): OutgoingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !names.has(name)))
}

/** A metadata response that cannot be decoded or held in memory, so it is relayed unchanged. */
class UnfilterableResponse extends Error {}

interface BufferedResponse {
  status: number
  statusMessage: string
  headers: IncomingHttpHeaders
  body: Buffer
}

/** One GET to the registry with the body decoded (only `gzip` is ever requested). */
function fetchBuffered(
  host: string,
  path: string,
  headers: OutgoingHttpHeaders,
  agent: HttpsAgent,
): Promise<BufferedResponse> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      host,
      port: 443,
      servername: host,
      method: 'GET',
      path,
      headers: { ...headers, 'accept-encoding': 'gzip' },
      agent,
    })
    request.setTimeout(METADATA_TIMEOUT_MS, () => {
      request.destroy(new Error(`Timed out fetching ${host}${path}`))
    })
    request.once('error', reject)
    request.once('response', (response) => {
      const encoding = response.headers['content-encoding']
      if (encoding !== undefined && encoding !== 'gzip' && encoding !== 'identity') {
        response.resume()
        reject(new UnfilterableResponse(`content-encoding ${encoding}`))
        return
      }
      const body = encoding === 'gzip' ? response.pipe(createGunzip()) : response
      const chunks: Buffer[] = []
      let size = 0
      body.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > METADATA_MAX_BYTES) {
          request.destroy(
            new UnfilterableResponse(`larger than ${String(METADATA_MAX_BYTES)} bytes`),
          )
          return
        }
        chunks.push(chunk)
      })
      body.once('error', reject)
      body.once('end', () => {
        resolve({
          status: response.statusCode ?? 502,
          statusMessage: response.statusMessage ?? '',
          headers: response.headers,
          body: Buffer.concat(chunks),
        })
      })
    })
    request.end()
  })
}

/**
 * Serve a buffered (decoded) response. A rewritten body loses the registry's
 * validators and may not be stored, so no cache (npm's, pip's, uv's) serves it
 * later to an install that runs without the firewall.
 */
function respondBuffered(
  response: ServerResponse,
  upstream: BufferedResponse,
  body: Buffer,
  rewritten: boolean,
): void {
  const headers = withoutHeaders(
    endToEndHeaders(upstream.headers),
    rewritten ? CACHE_HEADERS : ENCODING_HEADERS,
  )
  if (rewritten) headers['cache-control'] = 'no-store'
  headers['content-length'] = body.length
  response.writeHead(upstream.status, upstream.statusMessage, headers)
  response.end(body)
}

function rawResponse(socket: Duplex, status: string, extra = ''): void {
  socket.end(`HTTP/1.1 ${status}\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`)
}

const npmTimesSchema = z.object({ time: z.record(z.string(), z.unknown()).optional() })

/** The `time` map of a full npm packument. */
function parseTimes(text: string): Readonly<Record<string, unknown>> | undefined {
  return safeJsonParse(text, decodeWithSchema(npmTimesSchema))?.time
}

/** The package a GET for registry metadata describes. */
function metadataTarget(
  host: string,
  path: string,
  request: IncomingMessage,
): MetadataTarget | null {
  return request.method === 'GET' ? metadataForRequest(host, path) : null
}

export async function startPackageFirewallProxy(
  options: PackageFirewallProxyOptions,
): Promise<RunningFirewallProxy> {
  const expectedAuth = Buffer.from(
    `Basic ${Buffer.from(`${PROXY_USER}:${options.token}`).toString('base64')}`,
  )
  const authorized = (request: IncomingMessage): boolean => {
    const header = request.headers['proxy-authorization']
    if (typeof header !== 'string') return false
    const given = Buffer.from(header)
    return given.length === expectedAuth.length && timingSafeEqual(given, expectedAuth)
  }

  const contexts = new Map<string, SecureContext>()
  const contextFor = (host: string): SecureContext => {
    let context = contexts.get(host)
    if (!context) {
      const leaf = options.authority.issue(host)
      context = createSecureContext({ key: leaf.keyPem, cert: leaf.certPem })
      contexts.set(host, context)
    }
    return context
  }

  const open = new Set<Duplex>()
  const track = (stream: Duplex): void => {
    open.add(stream)
    stream.once('close', () => open.delete(stream))
    stream.on('error', () => {
      stream.destroy()
    })
  }

  /** Whether a download may proceed; answers 403 itself when it may not. */
  const admit = async (host: string, path: string, response: ServerResponse): Promise<boolean> => {
    const pkg = packageForDownload(host, path)
    if (!pkg) return true
    const verdict = await options.check(pkg)
    options.onDecision?.({ pkg, verdict })
    if (verdict.status !== 'blocked') return true
    respondBlocked(response, pkg, verdict)
    return false
  }

  const unreachable = (host: string, error: unknown, response: ServerResponse | null): void => {
    options.onUnreachable?.(host, error instanceof Error ? error : new Error(String(error)))
    if (response) respondPlain(response, 502, `Could not reach ${host}`)
  }

  /** Forward `request` upstream and stream the answer back. A consumed request sends no body. */
  const relay = (
    host: string,
    request: IncomingMessage,
    response: ServerResponse,
    upstreamRequest: ReturnType<typeof httpRequest>,
  ): void => {
    upstreamRequest.once('response', (upstream) => {
      response.writeHead(upstream.statusCode ?? 502, endToEndHeaders(upstream.headers))
      upstream.pipe(response)
    })
    upstreamRequest.once('error', (error) => {
      unreachable(host, error, response)
    })
    response.once('close', () => {
      if (!response.writableFinished) upstreamRequest.destroy()
    })
    if (request.readableEnded) upstreamRequest.end()
    else request.pipe(upstreamRequest)
  }

  const registryRequest = (
    host: string,
    method: string,
    path: string,
    headers: OutgoingHttpHeaders,
  ): ReturnType<typeof httpsRequest> =>
    httpsRequest({
      host,
      port: 443,
      servername: host,
      method,
      path,
      headers,
      agent: options.registryAgent,
    })

  /**
   * Answer a metadata GET with recent versions left out. The document is
   * fetched whole, without the client's validators, so a cached copy is never
   * revalidated against a document the client did not see. Anything that cannot
   * be filtered is served unchanged.
   */
  const serveMetadata = async (
    host: string,
    target: MetadataTarget,
    path: string,
    request: IncomingMessage,
    response: ServerResponse,
    releaseAge: NonNullable<PackageFirewallProxyOptions['releaseAge']>,
  ): Promise<void> => {
    request.resume()
    const headers = withoutHeaders(endToEndHeaders(request.headers), CONDITIONAL_HEADERS)
    headers['host'] = host
    let upstream: BufferedResponse
    try {
      upstream = await fetchBuffered(host, path, headers, options.registryAgent)
    } catch (error) {
      if (error instanceof UnfilterableResponse) {
        relay(host, request, response, registryRequest(host, 'GET', path, headers))
      } else {
        unreachable(host, error, response)
      }
      return
    }
    if (upstream.status !== 200) {
      respondBuffered(response, upstream, upstream.body, false)
      return
    }
    const cutoffMs = (releaseAge.now ?? Date.now)() - releaseAge.minAgeMs
    const fetchNpmTimes = async (): Promise<Readonly<Record<string, unknown>> | undefined> => {
      try {
        const full = await fetchBuffered(
          host,
          path,
          { ...headers, accept: 'application/json' },
          options.registryAgent,
        )
        if (full.status !== 200) return undefined
        return parseTimes(full.body.toString('utf8'))
      } catch {
        return undefined
      }
    }
    const recent = await hideRecentVersions(
      target,
      upstream.body.toString('utf8'),
      cutoffMs,
      fetchNpmTimes,
    )
    if (!recent || recent.hidden.length === 0) {
      respondBuffered(response, upstream, upstream.body, false)
      return
    }
    options.onRecentVersions?.(target, recent.hidden)
    respondBuffered(response, upstream, Buffer.from(recent.text), true)
  }

  // Decrypted requests from intercepted CONNECT tunnels. Never listens itself:
  // each TLS connection is handed to it with the host its CONNECT named, so the
  // certificate, the check and the forward all use that one host.
  const interceptedHost = new WeakMap<object, string>()
  const inspector = createServer((request, response) => {
    const host = interceptedHost.get(request.socket)
    if (!host) {
      respondPlain(response, 421, 'Misdirected request')
      return
    }
    const path = request.url ?? '/'
    const forward = async (): Promise<void> => {
      const metadata = metadataTarget(host, path, request)
      if (metadata && options.releaseAge) {
        await serveMetadata(host, metadata, path, request, response, options.releaseAge)
        return
      }
      if (!(await admit(host, path, response))) {
        request.resume()
        return
      }
      const headers = endToEndHeaders(request.headers)
      headers['host'] = host
      relay(host, request, response, registryRequest(host, request.method ?? 'GET', path, headers))
    }
    forward().catch(() => {
      respondPlain(response, 500, 'Could not check this download')
    })
  })
  inspector.on('clientError', (_error, socket) => {
    socket.destroy()
  })

  // Absolute-form plain-HTTP requests (`GET http://host/path`).
  const front = createServer((request, response) => {
    if (!authorized(request)) {
      response.writeHead(407, {
        'proxy-authenticate': `Basic realm="${REALM}"`,
        'content-length': 0,
      })
      response.end()
      return
    }
    let url: URL
    try {
      url = new URL(request.url ?? '')
    } catch {
      respondPlain(response, 400, 'Expected an absolute http:// URL')
      return
    }
    if (url.protocol !== 'http:') {
      respondPlain(response, 400, 'Expected an absolute http:// URL')
      return
    }
    const host = url.hostname.toLowerCase()
    const port = url.port ? Number(url.port) : 80
    const forward = async (): Promise<void> => {
      // Registry metadata is the same over either scheme; fetching it over
      // HTTPS keeps one code path, and the limit, for both.
      const metadata = metadataTarget(host, `${url.pathname}${url.search}`, request)
      if (metadata && options.releaseAge) {
        await serveMetadata(
          host,
          metadata,
          `${url.pathname}${url.search}`,
          request,
          response,
          options.releaseAge,
        )
        return
      }
      if (!(await admit(host, `${url.pathname}${url.search}`, response))) {
        request.resume()
        return
      }
      let socket: Socket
      try {
        socket = await options.connectTunnel(host, port)
      } catch (error) {
        unreachable(host, error, response)
        return
      }
      relay(
        host,
        request,
        response,
        httpRequest({
          host,
          port,
          method: request.method ?? 'GET',
          path: `${url.pathname}${url.search}`,
          headers: endToEndHeaders(request.headers),
          createConnection: () => socket,
        }),
      )
    }
    forward().catch(() => {
      respondPlain(response, 500, 'Could not check this download')
    })
  })

  front.on('connect', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    track(socket)
    if (!authorized(request)) {
      rawResponse(
        socket,
        '407 Proxy Authentication Required',
        `Proxy-Authenticate: Basic realm="${REALM}"\r\n`,
      )
      return
    }
    const target = parseAuthority(request.url ?? '')
    if (!target) {
      rawResponse(socket, '400 Bad Request')
      return
    }
    if (target.port === 443 && interceptedEcosystem(target.host)) {
      let secureContext: SecureContext
      try {
        secureContext = contextFor(target.host)
      } catch {
        rawResponse(socket, '502 Bad Gateway')
        return
      }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) socket.unshift(head)
      const secure = new TLSSocket(socket, {
        isServer: true,
        secureContext,
        ALPNProtocols: ['http/1.1'],
      })
      track(secure)
      interceptedHost.set(secure, target.host)
      inspector.emit('connection', secure)
      return
    }
    options.connectTunnel(target.host, target.port).then(
      (upstream) => {
        track(upstream)
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) upstream.write(head)
        upstream.pipe(socket)
        socket.pipe(upstream)
        upstream.once('close', () => socket.destroy())
        socket.once('close', () => upstream.destroy())
      },
      (error: unknown) => {
        unreachable(target.host, error, null)
        rawResponse(socket, '502 Bad Gateway')
      },
    )
  })
  front.on('clientError', (_error, socket) => {
    socket.destroy()
  })

  await new Promise<void>((resolve, reject) => {
    front.once('error', reject)
    front.listen(0, '127.0.0.1', () => {
      front.off('error', reject)
      resolve()
    })
  })
  const address = front.address()
  if (address === null || typeof address === 'string') throw new Error('Proxy has no TCP address')
  const port = (address satisfies AddressInfo).port

  return {
    port,
    url: `http://${PROXY_USER}:${options.token}@127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const stream of open) stream.destroy()
        front.closeAllConnections()
        front.close(() => {
          resolve()
        })
      }),
  }
}
