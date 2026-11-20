/**
 * The host side of a container run's GitHub read capability
 * (`docs/plans/thread-in-container.md`, decision A24).
 *
 * Each stream the guest's bridge opens on the link carries one HTTP request,
 * as a JSON head line and the body (`github-capability-wire.ts`). This module
 * decides it (`github-capability-policy.ts`), and for a request it admits:
 * removes whatever credential the guest sent, adds the user's token where the
 * policy says the host is token-bearing, re-originates HTTPS to the real host
 * from this process, and streams the answer back with the token redacted from
 * headers and body. Redirects are returned to the guest, never followed here,
 * so a token is never sent anywhere the guest's request did not name.
 *
 * The token comes from the desktop's own GitHub sign-in (the caller supplies
 * the lookup); with none, requests go out unauthenticated rather than failing.
 */
import { request as httpsRequest, type RequestOptions } from 'node:https'
import type { ClientRequest, IncomingMessage, OutgoingHttpHeaders } from 'node:http'
import type { Duplex, Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import type { EgressLogEntry } from '@shared/types/container-run.ts'
import { readOnlyGraphqlRequestBody } from '../github/graphql-read-only.ts'
import { decideGitHubRequest, type GitHubAuth } from './github-capability-policy.ts'
import {
  encodeHead,
  githubRequestHeadSchema,
  HeadReader,
  type GitHubRequestHead,
} from './github-capability-wire.ts'
import { SecretScrubber, scrubString } from './secret-scrubber.ts'

/** How the capability reaches the real GitHub: `https.request`, or a stand-in in tests. */
export type GitHubUpstream = (options: RequestOptions) => ClientRequest

export interface GitHubCapabilityOptions {
  /** The user's GitHub token, or null when the desktop has none. */
  token: () => Promise<string | null>
  /** The run's placeholder: never forwarded, and a canary anywhere but `Authorization`. */
  placeholder: string
  upstream?: GitHubUpstream
  /** Every decision and its outcome, for the run's egress record. */
  onLog?: (entry: EgressLogEntry) => void
}

/** Largest GraphQL body checked; a read query is a few kilobytes. */
const GRAPHQL_BODY_LIMIT = 1024 * 1024

/**
 * Requests one run may have open at once; more are refused with a 429. Each
 * holds a buffered GraphQL body, an upstream connection and, with no cached
 * sign-in, a token lookup, so a guest that opened thousands could exhaust the
 * desktop's memory.
 */
export const GITHUB_MAX_OPEN_REQUESTS = 32

/**
 * How long a request's head, and a GraphQL body, may take to arrive from the
 * guest before it is refused with a 408. Both are a few kilobytes on the
 * local link; a request that stalls part way must not hold its buffer.
 */
export const GITHUB_REQUEST_READ_TIMEOUT_MS = 30_000

/** Why reading a request from the guest stopped, and the status that says so. */
interface ReadRefusal {
  status: number
  reason: string
}

/** Request headers a GraphQL body is not forwarded with: the host sets its own type. */
const DROP_GRAPHQL_REQUEST_HEADERS = new Set(['content-type', 'content-encoding'])

/**
 * How long the upstream connection may sit idle (nothing sent or received)
 * before it is abandoned. Idle, not total: a log download or a large fetch
 * keeps bytes moving and may take as long as it needs.
 */
export const GITHUB_UPSTREAM_IDLE_TIMEOUT_MS = 120_000

/**
 * The body framing the guest declared, from its original headers. The host
 * never copies these headers through: it frames every upstream request itself
 * from this, and only a `stream` decision forwards a guest body at all.
 */
type RequestFraming =
  | { kind: 'empty' }
  | { kind: 'length'; length: number }
  | { kind: 'chunked' }
  | { kind: 'invalid'; reason: string }

export function requestFraming(headers: ReadonlyArray<readonly [string, string]>): RequestFraming {
  const lengths = headers.filter(([name]) => name.toLowerCase() === 'content-length')
  const encodings = headers.filter(([name]) => name.toLowerCase() === 'transfer-encoding')
  if (lengths.length > 0 && encodings.length > 0) {
    return {
      kind: 'invalid',
      reason: 'the request declares both Content-Length and Transfer-Encoding',
    }
  }
  if (encodings.length > 0) {
    const only = encodings.length === 1 ? encodings[0]?.[1].trim().toLowerCase() : undefined
    if (only !== 'chunked') {
      return { kind: 'invalid', reason: 'the request Transfer-Encoding is not plain chunked' }
    }
    return { kind: 'chunked' }
  }
  if (lengths.length > 0) {
    const only = lengths.length === 1 ? lengths[0]?.[1].trim() : undefined
    if (only === undefined || !/^\d{1,15}$/.test(only)) {
      return { kind: 'invalid', reason: 'the request Content-Length is malformed' }
    }
    const length = Number(only)
    return length === 0 ? { kind: 'empty' } : { kind: 'length', length }
  }
  return { kind: 'empty' }
}

/** Request headers never passed on: the hop's own, and anything carrying identity. */
const DROP_REQUEST_HEADERS = new Set([
  'host',
  'authorization',
  'proxy-authorization',
  'cookie',
  'connection',
  'proxy-connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'accept-encoding',
  'content-length',
  'expect',
  'http2-settings',
])

/** Header names the guest's `Connection` header marks as hop-by-hop, lowercased. */
function connectionNamed(headers: ReadonlyArray<readonly [string, string]>): Set<string> {
  const named = new Set<string>()
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== 'connection') continue
    for (const token of value.split(',')) {
      const trimmed = token.trim().toLowerCase()
      if (trimmed !== '') named.add(trimmed)
    }
  }
  return named
}

/** Headers some servers honour to run a request as a different method. */
const METHOD_OVERRIDE_HEADERS = new Set([
  'x-http-method-override',
  'x-http-method',
  'x-method-override',
])

/** Response headers never passed back: hop-by-hop, framing the guest recomputes, cookies. */
const DROP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'trailer',
  'upgrade',
  'set-cookie',
])

function refusalBody(reason: string): string {
  return `${JSON.stringify({ message: `Copse refused this request: ${reason}.` })}\n`
}

export function authorizationFor(auth: GitHubAuth, token: string | null): string | null {
  if (token === null || auth === 'none') return null
  if (auth === 'basic') {
    return `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
  }
  return `token ${token}`
}

/** Percent-decoded, or the text as it is when its encoding is malformed. */
function percentDecoded(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** Read the head line; resolves with it and the body's first bytes, or why it failed. */
function readHead(
  stream: Duplex,
): Promise<{ ok: true; head: GitHubRequestHead; rest: Buffer } | ({ ok: false } & ReadRefusal)> {
  return new Promise((resolveHead) => {
    const reader = new HeadReader()
    const onData = (chunk: Buffer): void => {
      let found: { line: string; rest: Buffer } | null
      try {
        found = reader.feed(chunk)
      } catch {
        finish({ ok: false, status: 400, reason: 'the request head is too large' })
        return
      }
      if (found === null) return
      const head = safeJsonParse(found.line, decodeWithSchema(githubRequestHeadSchema))
      finish(
        head === null
          ? { ok: false, status: 400, reason: 'the request head is malformed' }
          : { ok: true, head, rest: found.rest },
      )
    }
    const onEnd = (): void => {
      finish({ ok: false, status: 400, reason: 'the request ended before its head' })
    }
    const timer = setTimeout(() => {
      finish({ ok: false, status: 408, reason: 'the request head did not arrive in time' })
    }, GITHUB_REQUEST_READ_TIMEOUT_MS)
    const finish = (
      value: { ok: true; head: GitHubRequestHead; rest: Buffer } | ({ ok: false } & ReadRefusal),
    ): void => {
      clearTimeout(timer)
      stream.off('data', onData)
      stream.off('end', onEnd)
      stream.off('error', onEnd)
      stream.off('close', onEnd)
      stream.pause()
      resolveHead(value)
    }
    stream.on('data', onData)
    stream.on('end', onEnd)
    stream.on('error', onEnd)
    stream.on('close', onEnd)
  })
}

/**
 * The rest of the request body, up to `limit` bytes, or why it was not read.
 * Reading stops, without destroying the stream, at the limit or the deadline,
 * so the refusal can still be written back.
 */
function readBody(stream: Duplex, first: Buffer, limit: number): Promise<Buffer | ReadRefusal> {
  return new Promise((resolveBody) => {
    const parts: Buffer[] = [first]
    let bytes = first.length
    if (bytes > limit) {
      resolveBody({ status: 413, reason: 'the GraphQL request body is too large' })
      return
    }
    const onData = (chunk: Buffer): void => {
      bytes += chunk.length
      if (bytes > limit) {
        finish({ status: 413, reason: 'the GraphQL request body is too large' })
        return
      }
      parts.push(chunk)
    }
    const onEnd = (): void => {
      finish(Buffer.concat(parts))
    }
    const onError = (): void => {
      finish({ status: 400, reason: 'the request body could not be read' })
    }
    const timer = setTimeout(() => {
      finish({ status: 408, reason: 'the GraphQL request body did not arrive in time' })
    }, GITHUB_REQUEST_READ_TIMEOUT_MS)
    const finish = (value: Buffer | ReadRefusal): void => {
      clearTimeout(timer)
      stream.off('data', onData)
      stream.off('end', onEnd)
      stream.off('error', onError)
      stream.off('close', onError)
      stream.pause()
      // Drop what was buffered: a refused body is never needed.
      if (!Buffer.isBuffer(value)) parts.length = 0
      resolveBody(value)
    }
    stream.on('data', onData)
    stream.on('end', onEnd)
    stream.on('error', onError)
    stream.on('close', onError)
    stream.resume()
  })
}

function decoderFor(encoding: string | undefined): Duplex | null {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return createGunzip()
    case 'deflate':
      return createInflate()
    case 'br':
      return createBrotliDecompress()
    default:
      return null
  }
}

export class GitHubCapability {
  private readonly options: GitHubCapabilityOptions
  private readonly upstream: GitHubUpstream
  /** Every token this run used, so the post-run canary check can look for it. */
  private readonly used = new Set<string>()
  /** Requests being served now; see {@link GITHUB_MAX_OPEN_REQUESTS}. */
  private open = 0

  constructor(options: GitHubCapabilityOptions) {
    this.options = options
    this.upstream = options.upstream ?? httpsRequest
  }

  /**
   * The real tokens handed upstream during the run, each with its git Basic
   * encoding (for the post-run leak check).
   */
  tokensUsed(): string[] {
    return [...this.used]
  }

  private log(entry: Omit<EgressLogEntry, 'at'>): void {
    this.options.onLog?.({ at: Date.now(), ...entry })
  }

  private respondRefusal(stream: Duplex, status: number, reason: string, origin: string): void {
    this.log({ origin, event: 'refused', detail: reason })
    const body = refusalBody(reason)
    stream.write(
      encodeHead({
        status,
        headers: [
          ['Content-Type', 'application/json; charset=utf-8'],
          ['Content-Length', String(Buffer.byteLength(body))],
        ],
      }),
    )
    stream.end(body)
    // The request body, if any, is not wanted; let it drain to the END frame.
    stream.resume()
  }

  /** Serve one request on one link stream. */
  async serve(stream: Duplex): Promise<void> {
    if (this.open >= GITHUB_MAX_OPEN_REQUESTS) {
      this.respondRefusal(
        stream,
        429,
        `more than ${String(GITHUB_MAX_OPEN_REQUESTS)} GitHub requests are open at once`,
        'github',
      )
      return
    }
    this.open += 1
    try {
      await this.serveOpen(stream)
    } finally {
      this.open -= 1
    }
  }

  private async serveOpen(stream: Duplex): Promise<void> {
    const read = await readHead(stream)
    if (!read.ok) {
      this.respondRefusal(stream, read.status, read.reason, 'github')
      return
    }
    const { head, rest } = read
    const hostHeaders = head.headers.filter(([name]) => name.toLowerCase() === 'host')
    const hostHeader = hostHeaders.length === 1 ? (hostHeaders[0]?.[1] ?? null) : null
    const decision = decideGitHubRequest({
      method: head.method,
      target: head.target,
      host: hostHeader,
    })
    const label = `github ${head.method.slice(0, 8)} ${head.target.slice(0, 160)}`
    if (decision.action === 'refuse') {
      this.respondRefusal(stream, decision.status, decision.reason, label)
      return
    }
    // A read that asks the server to treat it as another method is a write.
    const override = head.headers.find(([name]) => METHOD_OVERRIDE_HEADERS.has(name.toLowerCase()))
    if (override !== undefined) {
      this.respondRefusal(stream, 403, `the ${override[0]} header is not allowed`, label)
      return
    }
    // The placeholder belongs in Authorization, which is dropped. Anywhere
    // else — the path, percent-encoded or not, another header's name or
    // value — it is being carried somewhere it was never meant to go, and the
    // request stops here.
    const placeholder = this.options.placeholder
    const carriesPlaceholder =
      head.target.includes(placeholder) ||
      percentDecoded(head.target).includes(placeholder) ||
      head.headers.some(
        ([name, value]) =>
          // Header names are case-insensitive, and a relay may lowercase them.
          name.toLowerCase().includes(placeholder.toLowerCase()) ||
          (name.toLowerCase() !== 'authorization' && value.includes(placeholder)),
      )
    if (carriesPlaceholder) {
      this.respondRefusal(
        stream,
        403,
        "the run's placeholder GitHub credential appeared outside the Authorization header",
        label,
      )
      return
    }

    const framing = requestFraming(head.headers)
    if (framing.kind === 'invalid') {
      this.respondRefusal(stream, 400, framing.reason, label)
      return
    }
    // A GET or HEAD goes upstream with no body and no framing headers. One
    // that declares a body is refused rather than trimmed, so nothing the
    // guest chose about framing can reach the token-bearing connection.
    if (decision.body === 'none' && framing.kind !== 'empty') {
      this.respondRefusal(stream, 400, `a ${head.method} request cannot carry a body`, label)
      return
    }

    let body: Buffer | null = null
    if (decision.body === 'graphql') {
      const received = await readBody(stream, rest, GRAPHQL_BODY_LIMIT)
      if (!Buffer.isBuffer(received)) {
        this.respondRefusal(stream, received.status, received.reason, label)
        return
      }
      if (received.includes(placeholder)) {
        this.respondRefusal(
          stream,
          403,
          "the run's placeholder GitHub credential appeared in the request body",
          label,
        )
        return
      }
      // Forward exactly what was checked, never the guest's own bytes.
      const checked = readOnlyGraphqlRequestBody(received.toString('utf8'))
      if (!checked.ok) {
        this.respondRefusal(stream, 403, checked.reason, label)
        return
      }
      body = Buffer.from(checked.body)
    }

    const hopByHop = connectionNamed(head.headers)
    const headers: OutgoingHttpHeaders = {}
    for (const [name, value] of head.headers) {
      const lower = name.toLowerCase()
      if (DROP_REQUEST_HEADERS.has(lower) || hopByHop.has(lower)) continue
      if (body !== null && DROP_GRAPHQL_REQUEST_HEADERS.has(lower)) continue
      const existing = headers[lower]
      headers[lower] =
        existing === undefined
          ? value
          : Array.isArray(existing)
            ? [...existing, value]
            : [String(existing), value]
    }
    headers['host'] = decision.host
    // Identity, so the body can be scanned for the token as it streams.
    headers['accept-encoding'] = 'identity'
    // Framing is the host's: the GraphQL body's own length, the guest's
    // validated length for a streamed body (enforced below), or chunked.
    // A bodyless decision sends neither header.
    let streamLength: number | null = null
    if (body !== null) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(body.length)
    } else if (decision.body === 'stream') {
      if (framing.kind === 'length') {
        streamLength = framing.length
        headers['content-length'] = String(framing.length)
      } else headers['transfer-encoding'] = 'chunked'
    }

    const token = await this.options.token().catch(() => null)
    const secrets = token === null ? [] : [token, authorizationFor('basic', token) ?? '']
    const authorization = authorizationFor(decision.auth, token)
    if (authorization !== null && token !== null) {
      headers['authorization'] = authorization
      this.used.add(token)
      // Git's Basic form of it too, which is what a leaked git header holds.
      this.used.add(Buffer.from(`x-access-token:${token}`).toString('base64'))
    }

    const origin = `github ${decision.host}`
    this.log({
      origin,
      event: 'connect',
      detail: `${head.method} ${decision.path.slice(0, 160)}${authorization !== null ? ' (with the desktop sign-in)' : ''}`,
    })
    let bytesToOrigin = 0
    let bytesFromOrigin = 0
    let finished = false
    const finish = (event: 'close' | 'error', detail?: string): void => {
      if (finished) return
      finished = true
      this.log({
        origin,
        event,
        bytesToOrigin,
        bytesFromOrigin,
        ...(detail !== undefined ? { detail } : {}),
      })
    }
    const reportLeak = (): void => {
      this.log({
        origin,
        event: 'error',
        detail: `the GitHub token appeared in a response from ${decision.host} and was redacted before the guest saw it`,
      })
    }

    await new Promise<void>((resolveServe) => {
      const outbound = this.upstream({
        method: head.method,
        host: decision.host,
        port: 443,
        path: decision.path,
        headers,
        servername: decision.host,
        // A connection of its own, closed after the answer: never pooled, so
        // no request can share a token-bearing connection with another.
        agent: false,
      })
      outbound.setTimeout(GITHUB_UPSTREAM_IDLE_TIMEOUT_MS, () => {
        outbound.destroy(new Error('GitHub did not answer in time'))
      })
      const stop = (): void => {
        outbound.destroy()
      }
      stream.once('close', stop)
      outbound.on('error', (error: Error) => {
        stream.off('close', stop)
        finish('error', error.message)
        if (!stream.destroyed && stream.writable) {
          const reason = `GitHub could not be reached (${error.message})`
          const text = refusalBody(reason)
          stream.write(
            encodeHead({
              status: 502,
              headers: [
                ['Content-Type', 'application/json; charset=utf-8'],
                ['Content-Length', String(Buffer.byteLength(text))],
              ],
            }),
          )
          stream.end(text)
        }
        resolveServe()
      })
      outbound.on('response', (response: IncomingMessage) => {
        const decoder = decoderFor(response.headers['content-encoding'])
        const responseHeaders: Array<[string, string]> = []
        let headerLeak = false
        for (let i = 0; i < response.rawHeaders.length; i += 2) {
          const name = response.rawHeaders[i] ?? ''
          const value = response.rawHeaders[i + 1] ?? ''
          const lower = name.toLowerCase()
          if (DROP_RESPONSE_HEADERS.has(lower)) continue
          if (decoder !== null && (lower === 'content-encoding' || lower === 'content-length')) {
            continue
          }
          const scrubbed = scrubString(value, secrets)
          if (scrubbed.leaked) headerLeak = true
          responseHeaders.push([name, scrubbed.value])
        }
        if (headerLeak) reportLeak()
        stream.write(encodeHead({ status: response.statusCode ?? 502, headers: responseHeaders }))
        const scrubber = new SecretScrubber(secrets, reportLeak)
        const source: Readable = decoder === null ? response : response.pipe(decoder)
        response.on('data', (chunk: Buffer) => {
          bytesFromOrigin += chunk.length
        })
        const failed = (error: Error): void => {
          finish('error', error.message)
          stream.destroy(error)
          resolveServe()
        }
        response.on('error', failed)
        decoder?.on('error', failed)
        scrubber.on('error', failed)
        source.pipe(scrubber).pipe(stream)
        scrubber.on('end', () => {
          stream.off('close', stop)
          finish('close')
          resolveServe()
        })
      })
      if (body !== null) {
        bytesToOrigin = body.length
        outbound.end(body)
        stream.resume()
        return
      }
      if (decision.body === 'stream') {
        // With a declared length, exactly that many bytes go upstream: more
        // or fewer abandons the request instead of mis-framing it.
        const forward = (chunk: Buffer): boolean => {
          if (streamLength !== null && bytesToOrigin + chunk.length > streamLength) {
            outbound.destroy(new Error('the request body is longer than its Content-Length'))
            stream.destroy()
            return false
          }
          bytesToOrigin += chunk.length
          return outbound.write(chunk)
        }
        if (rest.length > 0 && !forward(rest) && outbound.destroyed) return
        stream.on('data', (chunk: Buffer) => {
          if (forward(chunk) || outbound.destroyed) return
          stream.pause()
          outbound.once('drain', () => {
            stream.resume()
          })
        })
        stream.on('end', () => {
          if (streamLength !== null && bytesToOrigin !== streamLength) {
            outbound.destroy(new Error('the request body is shorter than its Content-Length'))
            return
          }
          outbound.end()
        })
        stream.resume()
        return
      }
      // GET/HEAD: no body and no framing go upstream. A body was refused
      // above if declared; undeclared stray bytes are drained, never sent.
      outbound.end()
      stream.resume()
    })
  }
}
