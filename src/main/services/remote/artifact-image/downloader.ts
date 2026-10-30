/**
 * The confined side of an artifact-image download: one GET, manual redirects,
 * streaming limits and signature checks. It runs inside ASRT with no
 * credentials and reaches the network only through its job's egress proxy.
 *
 * The transport is injected so tests can drive hostile servers directly; the
 * production transport ({@link proxyTunnelTransport}) tunnels through the
 * proxy and verifies TLS against the origin's own hostname.
 */
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { connect as netConnect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from 'node:tls'
import { EGRESS_PROXY_USER } from './egress-proxy.ts'
import {
  inspectArtifactImage,
  parseArtifactImageMime,
  type ArtifactImageMime,
} from './image-signature.ts'
import {
  ARTIFACT_IMAGE_DOWNLOAD_DEADLINE_MS,
  ARTIFACT_IMAGE_IDLE_TIMEOUT_MS,
  ArtifactImageError,
  checkDownloadUrl,
  MAX_ARTIFACT_IMAGE_BYTES,
  MAX_ARTIFACT_IMAGE_HEADER_BYTES,
  MAX_ARTIFACT_IMAGE_REDIRECTS,
  resolveRedirect,
  type ApprovedDownloadUrl,
} from './policy.ts'

export interface DownloadTransport {
  /** A verified HTTP/1.1-ready stream to `hostname:443`. Throws ArtifactImageError. */
  open(hostname: string, signal: AbortSignal): Promise<Duplex>
}

export interface DownloadLimits {
  deadlineMs: number
  idleMs: number
}

const DEFAULT_LIMITS: DownloadLimits = {
  deadlineMs: ARTIFACT_IMAGE_DOWNLOAD_DEADLINE_MS,
  idleMs: ARTIFACT_IMAGE_IDLE_TIMEOUT_MS,
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export interface DownloadedImage {
  mime: ArtifactImageMime
  bytes: Buffer
}

/** A call rather than a property read, so a check after an `await` is not narrowed away. */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal)
}

function abortError(signal: AbortSignal): ArtifactImageError {
  return signal.reason instanceof ArtifactImageError
    ? signal.reason
    : new ArtifactImageError('timeout')
}

type Hop = { kind: 'redirect'; location: string } | { kind: 'image'; image: DownloadedImage }

function readResponse(response: IncomingMessage, limits: DownloadLimits): Promise<Hop> {
  const status = response.statusCode ?? 0
  if (REDIRECT_STATUSES.has(status)) {
    response.resume()
    const location = response.headers.location
    if (typeof location !== 'string' || location.length === 0) {
      return Promise.reject(new ArtifactImageError('redirect-denied'))
    }
    return Promise.resolve({ kind: 'redirect', location })
  }
  if (status !== 200) {
    response.resume()
    // The status alone; a response body may echo signed query parameters.
    return Promise.reject(new ArtifactImageError('http-status', String(status)))
  }
  const encoding = response.headers['content-encoding']
  if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity') {
    response.destroy()
    return Promise.reject(new ArtifactImageError('bad-encoding'))
  }
  const mime = parseArtifactImageMime(response.headers['content-type'])
  if (!mime) {
    response.destroy()
    return Promise.reject(new ArtifactImageError('bad-type'))
  }
  const declared = response.headers['content-length']
  if (declared !== undefined) {
    if (!/^\d{1,12}$/u.test(declared)) {
      response.destroy()
      return Promise.reject(new ArtifactImageError('protocol'))
    }
    if (Number(declared) > MAX_ARTIFACT_IMAGE_BYTES) {
      response.destroy()
      return Promise.reject(new ArtifactImageError('too-large'))
    }
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(idle)
      fn()
    }
    const stall = (): void => {
      settle(() => {
        response.destroy()
        reject(new ArtifactImageError('timeout'))
      })
    }
    let idle = setTimeout(stall, limits.idleMs)
    response.on('data', (chunk: Buffer) => {
      if (settled) return
      received += chunk.length
      // Stop on the first overrun, whatever Content-Length claimed.
      if (received > MAX_ARTIFACT_IMAGE_BYTES) {
        settle(() => {
          response.destroy()
          reject(new ArtifactImageError('too-large'))
        })
        return
      }
      chunks.push(chunk)
      clearTimeout(idle)
      idle = setTimeout(stall, limits.idleMs)
    })
    response.once('error', () => {
      settle(() => {
        reject(new ArtifactImageError('network'))
      })
    })
    response.once('aborted', () => {
      settle(() => {
        reject(new ArtifactImageError('network'))
      })
    })
    response.once('end', () => {
      settle(() => {
        if (!response.complete) {
          reject(new ArtifactImageError('network'))
          return
        }
        const bytes = Buffer.concat(chunks)
        if (declared !== undefined && bytes.length !== Number(declared)) {
          reject(new ArtifactImageError('protocol'))
          return
        }
        const inspection = inspectArtifactImage(bytes, mime)
        if (!inspection.ok) {
          reject(new ArtifactImageError(inspection.reason === 'type' ? 'bad-type' : 'bad-image'))
          return
        }
        resolve({ kind: 'image', image: { mime, bytes } })
      })
    })
  })
}

function requestOnce(
  target: ApprovedDownloadUrl,
  stream: Duplex,
  signal: AbortSignal,
  limits: DownloadLimits,
): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      method: 'GET',
      // Exactly the bytes the provider signed; never re-serialized.
      path: target.target,
      createConnection: () => stream,
      maxHeaderSize: MAX_ARTIFACT_IMAGE_HEADER_BYTES,
      // No Authorization, Cookie, Referer or inherited headers.
      headers: {
        Host: target.hostname,
        Accept: 'image/png, image/jpeg, image/gif, image/webp',
        'Accept-Encoding': 'identity',
        'User-Agent': 'copse-artifact-image',
        Connection: 'close',
      },
      signal,
    })
    request.once('error', (error: NodeJS.ErrnoException) => {
      if (signal.aborted) {
        reject(abortError(signal))
        return
      }
      reject(
        new ArtifactImageError(
          error.code === 'HPE_HEADER_OVERFLOW' || error.code?.startsWith('HPE_') === true
            ? 'protocol'
            : 'network',
        ),
      )
    })
    request.once('response', (response) => {
      readResponse(response, limits).then(resolve, (error: unknown) => {
        reject(
          signal.aborted
            ? abortError(signal)
            : error instanceof ArtifactImageError
              ? error
              : new ArtifactImageError('network'),
        )
      })
    })
    request.end()
  })
}

/**
 * Download one artifact image. The URL is rechecked here even though main
 * checked it: this side does not trust its input any more than main trusts
 * this side's output.
 */
export async function downloadArtifactImage(
  job: { url: string; approvedOrigins: readonly string[] },
  transport: DownloadTransport,
  limits: DownloadLimits = DEFAULT_LIMITS,
): Promise<DownloadedImage> {
  const signal = AbortSignal.timeout(limits.deadlineMs)
  let current = checkDownloadUrl(job.url, job.approvedOrigins)
  for (let hop = 0; hop <= MAX_ARTIFACT_IMAGE_REDIRECTS; hop++) {
    throwIfAborted(signal)
    let stream: Duplex
    try {
      stream = await transport.open(current.hostname, signal)
    } catch (error) {
      throwIfAborted(signal)
      if (error instanceof ArtifactImageError) {
        // The proxy refusing a redirect target is a redirect denial.
        throw hop > 0 && error.code === 'origin-denied'
          ? new ArtifactImageError('redirect-denied', current.origin)
          : error
      }
      throw new ArtifactImageError('network')
    }
    let result: Hop
    try {
      result = await requestOnce(current, stream, signal, limits)
    } finally {
      stream.destroy()
    }
    if (result.kind === 'image') return result.image
    if (hop === MAX_ARTIFACT_IMAGE_REDIRECTS) break
    current = resolveRedirect(current, result.location, job.approvedOrigins)
  }
  throw new ArtifactImageError('too-many-redirects')
}

/** The downloader's proxy, as ASRT advertises it: always a loopback HTTP proxy. */
export function proxyPortFromEnv(env: NodeJS.ProcessEnv): number | null {
  const raw = env['HTTPS_PROXY'] ?? env['https_proxy']
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' || (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1')) {
    return null
  }
  const port = Number(url.port)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

const PROXY_CONNECT_RETRY_MS = 50
/** ASRT starts Linux's in-namespace socat bridge in the background; give it a moment. */
const PROXY_CONNECT_WINDOW_MS = 3_000
const MAX_PROXY_RESPONSE_BYTES = 8 * 1024

export interface TunnelDependencies {
  connectProxy?: (port: number) => Socket
  tlsConnect?: (options: ConnectionOptions) => TLSSocket
}

function connectProxyOnce(port: number, connect: (port: number) => Socket): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port)
    socket.once('connect', () => {
      socket.removeAllListeners('error')
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

async function connectProxy(
  port: number,
  connect: (port: number) => Socket,
  signal: AbortSignal,
): Promise<Socket> {
  const until = Date.now() + PROXY_CONNECT_WINDOW_MS
  for (;;) {
    try {
      return await connectProxyOnce(port, connect)
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code !== 'ECONNREFUSED' || Date.now() >= until || signal.aborted) {
        throw new ArtifactImageError('network')
      }
      await new Promise((resolve) => setTimeout(resolve, PROXY_CONNECT_RETRY_MS))
    }
  }
}

function readConnectResponse(socket: Socket, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    const cleanup = (): void => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onError)
      signal.removeEventListener('abort', onError)
    }
    const onError = (): void => {
      cleanup()
      reject(new ArtifactImageError(signal.aborted ? 'timeout' : 'network'))
    }
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf('\r\n\r\n')
      if (end === -1) {
        if (buffered.length > MAX_PROXY_RESPONSE_BYTES) {
          cleanup()
          reject(new ArtifactImageError('protocol'))
        }
        return
      }
      cleanup()
      // The proxy sends nothing after its status until the tunnel carries TLS.
      if (end + 4 !== buffered.length) {
        reject(new ArtifactImageError('protocol'))
        return
      }
      const status = /^HTTP\/1\.[01] (\d{3})/u.exec(buffered.toString('latin1'))?.[1]
      resolve(status ? Number(status) : 0)
    }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onError)
    signal.addEventListener('abort', onError, { once: true })
  })
}

function isTlsError(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? String(error.code) : ''
  return (
    code.startsWith('ERR_TLS') ||
    code.startsWith('ERR_SSL') ||
    code.startsWith('CERT_') ||
    code.startsWith('UNABLE_TO_') ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'HOSTNAME_MISMATCH'
  )
}

/**
 * CONNECT through this job's egress proxy, then TLS to the origin by name.
 * Certificate verification uses the runtime's bundled roots and the original
 * hostname; it is never disabled to accommodate the proxy's address pinning.
 */
export function proxyTunnelTransport(
  proxyPort: number,
  token: string,
  dependencies: TunnelDependencies = {},
): DownloadTransport {
  const connect =
    dependencies.connectProxy ?? ((port: number): Socket => netConnect({ host: '127.0.0.1', port }))
  const secure = dependencies.tlsConnect ?? tlsConnect
  const credential = Buffer.from(`${EGRESS_PROXY_USER}:${token}`, 'utf8').toString('base64')
  return {
    async open(hostname, signal): Promise<Duplex> {
      const socket = await connectProxy(proxyPort, connect, signal)
      try {
        socket.write(
          `CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\nProxy-Authorization: Basic ${credential}\r\n\r\n`,
        )
        const status = await readConnectResponse(socket, signal)
        if (status === 403) throw new ArtifactImageError('origin-denied', `https://${hostname}`)
        if (status !== 200) throw new ArtifactImageError('network')
        const tls = secure({
          socket,
          servername: hostname,
          ALPNProtocols: ['http/1.1'],
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
        })
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => {
            tls.destroy()
            reject(new ArtifactImageError('timeout'))
          }
          signal.addEventListener('abort', onAbort, { once: true })
          tls.once('secureConnect', () => {
            signal.removeEventListener('abort', onAbort)
            tls.removeAllListeners('error')
            resolve()
          })
          tls.once('error', (error) => {
            signal.removeEventListener('abort', onAbort)
            reject(new ArtifactImageError(isTlsError(error) ? 'tls' : 'network'))
          })
        })
        return tls
      } catch (error) {
        socket.destroy()
        throw error
      }
    },
  }
}
