import http2 from 'node:http2'
import { isIP } from 'node:net'
import type { Duplex } from 'node:stream'
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from 'node:tls'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import {
  HEADER_CLIENT_IP,
  TUNNEL_LINE_MAX_BYTES,
  TunnelChallenge,
  TunnelReady,
  tunnelSigningText,
} from '@copse/remote-protocol/tunnel.ts'
import { errorMessage } from '@shared/errors.ts'

/** The relay a Mac holds its tunnel to (copse-web-access plan, decision 7). */
export const DEFAULT_RELAY = 'relay.copse.dev'

export interface RelayEndpoint {
  host: string
  port: number
}

/**
 * `host` or `host:port`. The host must be a DNS name: the relay routes on the
 * ClientHello's server name, and an IP literal is never sent as one.
 */
export function parseRelayEndpoint(value: string): RelayEndpoint | null {
  const match =
    /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)(?::(\d{1,5}))?$/i.exec(
      value.trim(),
    )
  const host = match?.[1]
  if (!match || !host || isIP(host) !== 0) return null
  const port = match[2] === undefined ? 443 : Number(match[2])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
  return { host: host.toLowerCase(), port }
}

export interface RelayTunnelStatus {
  state: 'connecting' | 'connected' | 'retrying' | 'stopped'
  /** Why the last attempt or connection ended, while retrying. */
  error: string | null
  /** When the next attempt starts, while retrying. */
  retryAt: number | null
}

export interface RelayTunnelOptions {
  endpoint: RelayEndpoint
  label: string
  /** Signs the challenge text with this Mac's device key. */
  sign: (text: string) => Promise<string>
  /**
   * One browser connection: its TLS bytes from the ClientHello on, to be
   * completed against this Mac's own certificate. `clientIp` is the address
   * the relay saw, for limits and logs only.
   */
  onStream: (stream: Duplex, clientIp: string) => void
  onStatus: (status: RelayTunnelStatus) => void
  /** Opens the TLS connection to the relay; tests trust their own relay CA here. */
  connect?: (options: ConnectionOptions) => TLSSocket
  now?: () => number
  random?: () => number
  handshakeTimeoutMs?: number
}

/** Browser connections one tunnel serves at once; the relay caps them per label too. */
export const RELAY_MAX_STREAMS = 32
const MIN_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 300_000
/** A tunnel that stayed up this long resets the backoff; a flapping one keeps backing off. */
const STABLE_MS = 60_000
/** HTTP/2 PING interval; a ping still unanswered at the next one closes the tunnel. */
const KEEPALIVE_MS = 25_000

/** Delay before reconnect attempt `failures` (1-based): doubling, capped, with ±20% jitter. */
export function relayBackoffMs(failures: number, random: () => number = Math.random): number {
  const base = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** Math.max(0, failures - 1))
  return Math.round(base * (0.8 + 0.4 * random()))
}

class TunnelRefused extends Error {}

/**
 * This Mac's outbound tunnel to the Copse relay. The relay terminates only
 * this connection's TLS (its own certificate); after a challenge signed by the
 * device key, the Mac serves HTTP/2 on it with the relay as the client. Every
 * browser connection arrives as one `CONNECT` stream for
 * `web.<label>.u.copse.me:443` carrying the browser's TLS unchanged, so the
 * relay never sees what a phone and this Mac exchange.
 */
export class RelayTunnel {
  private readonly options: RelayTunnelOptions
  private readonly now: () => number
  private readonly random: () => number
  private readonly authority: string
  private current: RelayTunnelStatus = { state: 'stopped', error: null, retryAt: null }
  private socket: TLSSocket | null = null
  private session: http2.ServerHttp2Session | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private keepalive: ReturnType<typeof setInterval> | null = null
  private failures = 0
  private running = false
  private attempt = 0
  private readonly streams = new Set<http2.ServerHttp2Stream>()

  constructor(options: RelayTunnelOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    this.authority = `web.${options.label}.u.copse.me:443`
  }

  status(): RelayTunnelStatus {
    return { ...this.current }
  }

  /** Connect, and keep reconnecting until `stop()`. */
  start(): void {
    if (this.running) return
    this.running = true
    this.failures = 0
    void this.connect()
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.attempt += 1
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.teardown()
    this.update({ state: 'stopped', error: null, retryAt: null })
  }

  private async connect(): Promise<void> {
    const attempt = ++this.attempt
    const live = (): boolean => this.running && attempt === this.attempt
    this.update({ state: 'connecting', error: null, retryAt: null })
    const { endpoint } = this.options
    const connect = this.options.connect ?? tlsConnect
    let socket: TLSSocket
    try {
      socket = connect({
        host: endpoint.host,
        port: endpoint.port,
        servername: endpoint.host,
        ALPNProtocols: ['h2'],
        minVersion: 'TLSv1.2',
      })
    } catch (error) {
      this.closed(attempt, `Could not reach ${endpoint.host}: ${errorMessage(error)}`, 0)
      return
    }
    this.socket = socket
    let lastError: string | null = null
    let connectedAt = 0
    socket.on('error', (error) => {
      lastError ??= `Could not reach ${endpoint.host}: ${errorMessage(error)}`
    })
    socket.on('close', () => {
      this.closed(attempt, lastError ?? 'The relay closed the tunnel.', connectedAt)
    })
    try {
      const timeoutMs = this.options.handshakeTimeoutMs ?? 15_000
      const challenge = safeJsonParse(
        await readLine(socket, TUNNEL_LINE_MAX_BYTES, timeoutMs),
        decodeWithSchema(TunnelChallenge),
      )
      if (!challenge) throw new TunnelRefused('The relay sent an unexpected greeting.')
      const timestampMs = this.now()
      const signature = await this.options.sign(
        tunnelSigningText(this.options.label, challenge.challenge, timestampMs),
      )
      if (!live()) return
      await writeFlushed(
        socket,
        `${JSON.stringify({ type: 'auth', label: this.options.label, timestampMs, signature })}\n`,
      )
      const readyLine = await readLine(socket, TUNNEL_LINE_MAX_BYTES, timeoutMs).catch(() => null)
      const ready =
        readyLine === null ? null : safeJsonParse(readyLine, decodeWithSchema(TunnelReady))
      // The relay answers a bad signature, an inactive label or a blocklisted
      // key by closing, never with a reason.
      if (!ready)
        throw new TunnelRefused(
          'The relay refused this Mac. Its name may be inactive, or this Mac’s clock may be wrong.',
        )
      if (!live()) return
    } catch (error) {
      if (error instanceof TunnelRefused) lastError = error.message
      else lastError ??= errorMessage(error)
      socket.destroy()
      return
    }

    const session = http2.performServerHandshake(socket, {
      settings: { maxConcurrentStreams: RELAY_MAX_STREAMS },
    })
    this.session = session
    connectedAt = this.now()
    session.on('error', (error) => {
      lastError ??= `The tunnel failed: ${errorMessage(error)}`
      session.destroy()
    })
    session.on('close', () => {
      socket.destroy()
    })
    session.on('stream', (stream, headers) => {
      this.acceptStream(stream, headers)
    })
    let awaitingPing = false
    this.keepalive = setInterval(() => {
      if (awaitingPing) {
        lastError ??= 'The relay stopped answering.'
        session.destroy()
        return
      }
      awaitingPing = true
      session.ping((error) => {
        awaitingPing = false
        if (error) session.destroy()
      })
    }, KEEPALIVE_MS)
    this.keepalive.unref()
    socket.setKeepAlive(true, 30_000)
    this.update({ state: 'connected', error: null, retryAt: null })
  }

  private acceptStream(stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders): void {
    // Closing a stream with an error code emits `error` on it here too.
    stream.on('error', () => {
      stream.destroy()
    })
    const clientIp = headers[HEADER_CLIENT_IP]
    if (
      headers[':method'] !== 'CONNECT' ||
      headers[':authority'] !== this.authority ||
      typeof clientIp !== 'string' ||
      isIP(clientIp) === 0 ||
      this.streams.size >= RELAY_MAX_STREAMS
    ) {
      stream.close(http2.constants.NGHTTP2_REFUSED_STREAM)
      return
    }
    this.streams.add(stream)
    stream.on('close', () => this.streams.delete(stream))
    stream.respond({ ':status': 200 })
    this.options.onStream(stream, clientIp)
  }

  private closed(attempt: number, error: string, connectedAt: number): void {
    if (attempt !== this.attempt) return
    this.teardown()
    if (!this.running) return
    if (connectedAt > 0 && this.now() - connectedAt >= STABLE_MS) this.failures = 0
    this.failures += 1
    const retryAt = this.now() + relayBackoffMs(this.failures, this.random)
    this.update({ state: 'retrying', error, retryAt })
    this.retry = setTimeout(() => {
      this.retry = null
      if (this.running) void this.connect()
    }, retryAt - this.now())
    this.retry.unref()
  }

  private teardown(): void {
    if (this.keepalive) clearInterval(this.keepalive)
    this.keepalive = null
    for (const stream of this.streams) stream.destroy()
    this.streams.clear()
    this.session?.destroy()
    this.session = null
    this.socket?.destroy()
    this.socket = null
  }

  private update(status: RelayTunnelStatus): void {
    this.current = status
    this.options.onStatus(this.status())
  }
}

/** Read one newline-terminated line, leaving every later byte unread for HTTP/2. */
function readLine(stream: Duplex, maxBytes: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    const done = (error: Error | null, line = ''): void => {
      clearTimeout(timer)
      stream.off('data', onData)
      stream.off('end', onEnd)
      stream.off('close', onEnd)
      stream.off('error', onError)
      if (error) reject(error)
      else resolve(line)
    }
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      const newline = buffered.indexOf(0x0a)
      if (newline === -1) {
        if (buffered.length > maxBytes) done(new Error('The relay sent an overlong line.'))
        return
      }
      if (newline > maxBytes) {
        done(new Error('The relay sent an overlong line.'))
        return
      }
      stream.pause()
      const rest = buffered.subarray(newline + 1)
      if (rest.length > 0) stream.unshift(rest)
      done(null, buffered.subarray(0, newline).toString('utf8'))
    }
    const onEnd = (): void => {
      done(new Error('The relay closed the connection.'))
    }
    const onError = (error: Error): void => {
      done(error)
    }
    const timer = setTimeout(() => {
      done(new Error('The relay did not answer in time.'))
    }, timeoutMs)
    stream.on('data', onData)
    stream.on('end', onEnd)
    stream.on('close', onEnd)
    stream.on('error', onError)
    stream.resume()
  })
}

/** HTTP/2 takes over the socket's native handle, so no handshake write may still be queued. */
function writeFlushed(stream: Duplex, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(text, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}
