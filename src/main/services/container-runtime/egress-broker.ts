/**
 * Host-side egress broker for a container run (`docs/plans/thread-in-container.md`,
 * decisions A2 and A8).
 *
 * The guest has no network interface. It has one link to the host — frames
 * over its own stdio (`egress-link.ts`) — and a loopback HTTP proxy that opens
 * a fresh stream on that link for every outbound request, naming the target:
 *
 *     OPEN host:port
 *
 * The broker matches that target against the run's allowlist — exact
 * `host:port` rules and `*.suffix:port` wildcards — and either accepts the
 * stream and pipes bytes to the origin, or refuses it with a reason. TLS stays
 * end to end; the broker sees a target name and a byte count, never a
 * plaintext request.
 *
 * This replaced one unix socket and one guest listener per origin, which could
 * not express a wildcard and blackholed a second origin on a shared port. The
 * single unix socket that followed did not survive contact with Docker
 * Desktop, whose VirtioFS file sharing cannot carry a socket into the VM, so
 * the link is the container's stdio now and the broker owns no socket at all.
 *
 * Refusals are logged, because they can happen: a target the guest asked for
 * and did not get is exactly what a reviewer wants to see.
 */
import { lookup as dnsLookup } from 'node:dns'
import { connect, type Socket, type TcpSocketConnectOpts } from 'node:net'
import type { Readable } from 'node:stream'
import type { EgressLogEntry } from '@shared/types/container-run.ts'
import { EgressLink, type EgressLinkOutput, type MuxStream } from './egress-link.ts'
import {
  findEgressRule,
  formatEgressRule,
  parseEgressTarget,
  type EgressRule,
} from './egress-rules.ts'

export type { EgressLogEntry } from '@shared/types/container-run.ts'
export type { EgressRule } from './egress-rules.ts'

export interface EgressBrokerOptions {
  rules: readonly EgressRule[]
  /**
   * Hosts the broker should dial at a different address from the one the guest
   * named — a scripted model server on the host's loopback standing in for a
   * real origin, for instance. Keyed by the exact host the guest asks for; the
   * value is `addr` or `addr:port`, the second form when the stand-in listens
   * on a different port from the one the guest was told (an ephemeral port
   * playing 443, say). The allowlist is matched on what the guest asked for,
   * never on where the dial went.
   */
  resolve?: Readonly<Record<string, string>>
}

type LookupFunction = NonNullable<TcpSocketConnectOpts['lookup']>

/** How long one answer from the resolver serves every dial to that host. */
const LOOKUP_TTL_MS = 5 * 60_000

/**
 * A dial that failed this way is worth another go: the host's resolver
 * throttled or timed out, or the origin dropped the handshake. A refused
 * connection or an unknown host is not.
 */
const TRANSIENT_DIAL_CODES = new Set(['EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT'])
const DIAL_ATTEMPTS = 3
const DIAL_BACKOFF_MS = [250, 750]

/**
 * One resolver answer per host per run. A dependency install opens a
 * connection per package — a thousand lookups of the same name in a minute,
 * which the desktop's resolver answered with ENOTFOUND part way through the
 * first real install. `net.connect` takes a lookup of its own; this is that,
 * with a cache in front.
 */
function cachedLookup(): LookupFunction {
  const cache = new Map<string, { address: string; family: number; at: number }>()
  return (hostname, options, callback) => {
    if (options.all) {
      dnsLookup(hostname, options, callback)
      return
    }
    const hit = cache.get(hostname)
    if (hit && Date.now() - hit.at < LOOKUP_TTL_MS) {
      callback(null, hit.address, hit.family)
      return
    }
    dnsLookup(hostname, options, (error, address, family) => {
      if (!error && typeof address === 'string') {
        cache.set(hostname, { address, family, at: Date.now() })
      }
      callback(error, address, family)
    })
  }
}

function dialCode(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : ''
}

/** Dial the origin, retrying a transient failure; resolves with a connected socket. */
async function dialOrigin(
  target: { host: string; port: number },
  lookup: LookupFunction,
): Promise<Socket> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await new Promise<Socket>((resolveDial, reject) => {
        const socket = connect({ host: target.host, port: target.port, lookup })
        socket.once('connect', () => {
          resolveDial(socket)
        })
        socket.once('error', (error) => {
          socket.destroy()
          reject(error)
        })
      })
    } catch (error) {
      if (attempt >= DIAL_ATTEMPTS || !TRANSIENT_DIAL_CODES.has(dialCode(error))) throw error
      await new Promise((resolveWait) =>
        setTimeout(resolveWait, DIAL_BACKOFF_MS[attempt - 1] ?? DIAL_BACKOFF_MS.at(-1)),
      )
    }
  }
}

/** Where to dial for a guest-named target, after any `resolve` remap. */
function dialAddress(
  resolve: Readonly<Record<string, string>>,
  host: string,
  port: number,
): { host: string; port: number } {
  const mapped = resolve[host]
  if (mapped === undefined) return { host, port }
  const remapped = parseEgressTarget(mapped)
  return remapped ?? { host: mapped, port }
}

export class EgressBroker {
  private link: EgressLink | null = null
  private readonly entries: EgressLogEntry[] = []
  private readonly live = new Set<Socket | MuxStream>()
  private readonly rules: readonly EgressRule[]
  private readonly resolve: Readonly<Record<string, string>>
  private readonly lookup = cachedLookup()

  constructor(options: EgressBrokerOptions) {
    this.rules = options.rules
    this.resolve = options.resolve ?? {}
  }

  /**
   * Serve one link: `input` carries the guest's frames in, `output` takes the
   * broker's frames back. For a real run these are the attached container's
   * stdout and stdin; a test hands over two in-memory streams.
   */
  attach(input: Readable, output: EgressLinkOutput): void {
    if (this.link) throw new Error('the broker already has a link')
    this.link = new EgressLink(input, output, {
      onOpen: (id, target): void => {
        this.open(id, target)
      },
    })
  }

  /** Decide, then either bridge or refuse. */
  private open(id: number, target: string): void {
    const link = this.link
    if (!link) return
    const parsed = parseEgressTarget(target)
    if (parsed === null) {
      this.refuse(link, id, target.slice(0, 80), 'malformed request')
      return
    }
    const label = `${parsed.host}:${String(parsed.port)}`
    const rule = findEgressRule(this.rules, parsed.host, parsed.port)
    if (rule === null) {
      this.refuse(link, id, label, 'not in the allowlist')
      return
    }
    this.bridge(link, id, label, rule, parsed.host, parsed.port)
  }

  private refuse(link: EgressLink, id: number, label: string, reason: string): void {
    this.entries.push({ at: Date.now(), origin: label, event: 'refused', detail: reason })
    link.refuse(id, `DENY ${reason}`)
  }

  private bridge(
    link: EgressLink,
    id: number,
    label: string,
    rule: EgressRule,
    host: string,
    port: number,
  ): void {
    let bytesToOrigin = 0
    let bytesFromOrigin = 0
    this.entries.push({
      at: Date.now(),
      origin: label,
      event: 'connect',
      detail: `rule ${formatEgressRule(rule)}`,
    })
    const dial = dialAddress(this.resolve, host, port)
    let upstream: Socket | null = null
    let guest: MuxStream | null = null
    let closed = false
    const finish = (event: 'close' | 'error', detail?: string): void => {
      if (closed) return
      closed = true
      this.entries.push({
        at: Date.now(),
        origin: label,
        event,
        bytesToOrigin,
        bytesFromOrigin,
        ...(detail !== undefined ? { detail } : {}),
      })
      if (upstream) {
        upstream.destroy()
        this.live.delete(upstream)
      }
      if (guest) {
        guest.destroy(event === 'error' && detail !== undefined ? new Error(detail) : undefined)
        this.live.delete(guest)
      }
    }
    dialOrigin(dial, this.lookup).then(
      (socket) => {
        if (this.link !== link || link.isClosed) {
          socket.destroy()
          finish('close')
          return
        }
        upstream = socket
        this.live.add(socket)
        // Accepted only now: the guest's stream exists once the origin
        // answered, so a dial that fails is a refusal, not a connection that
        // broke.
        const stream = link.accept(id)
        guest = stream
        this.live.add(stream)
        stream.on('data', (chunk: Buffer) => {
          bytesToOrigin += chunk.length
        })
        socket.on('data', (chunk: Buffer) => {
          bytesFromOrigin += chunk.length
        })
        stream.pipe(socket)
        socket.pipe(stream)
        stream.on('error', (error) => {
          finish('error', `guest: ${error.message}`)
        })
        stream.on('close', () => {
          finish('close')
        })
        socket.on('error', (error) => {
          finish('error', `origin: ${error.message}`)
        })
        socket.on('close', () => {
          finish('close')
        })
      },
      (error: unknown) => {
        // The origin never answered, after the retries a transient fault
        // gets: the guest is still waiting, so tell it, then record it.
        const message = error instanceof Error ? error.message : String(error)
        if (this.link === link && !link.isClosed) {
          link.refuse(id, `DENY origin unreachable: ${message}`)
        }
        finish('error', `origin: ${message}`)
      },
    )
  }

  log(): EgressLogEntry[] {
    return [...this.entries]
  }

  /** Sever every stream and the link; the byte streams themselves are the caller's. */
  stop(): void {
    for (const stream of this.live) stream.destroy()
    this.live.clear()
    this.link?.close(undefined)
    this.link = null
  }
}
