/**
 * Host-side egress broker for a container run (`docs/plans/thread-in-container.md`,
 * decision A2).
 *
 * The guest has no network interface. It has one unix socket, mounted from the
 * host, and a loopback HTTP proxy that opens a fresh connection on that socket
 * for every outbound request and writes one line first:
 *
 *     CONNECT host:port\n
 *
 * The broker matches that target against the run's allowlist — exact
 * `host:port` rules and `*.suffix:port` wildcards — and answers `OK\n` and
 * starts piping bytes, or `DENY <reason>\n` and closes. TLS stays end to end;
 * the broker sees a target name and a byte count, never a plaintext request.
 *
 * This replaces one unix socket and one guest listener per origin. That scheme
 * could not express a wildcard, and two origins on the same port both tried to
 * bind the same loopback port in the guest, so the second listener died
 * unlogged and its origin silently blackholed. One socket, one line of
 * protocol, and the allowlist decided on the host side removes both.
 *
 * Refusals are logged now, because they can happen: a target the guest asked
 * for and did not get is exactly what a reviewer wants to see.
 */
import { chmodSync, rmSync } from 'node:fs'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import type { EgressLogEntry } from '@shared/types/container-run.ts'
import {
  BROKER_SOCKET_NAME,
  findEgressRule,
  formatEgressRule,
  parseEgressTarget,
  type EgressRule,
} from './egress-rules.ts'

export type { EgressLogEntry } from '@shared/types/container-run.ts'
export type { EgressRule } from './egress-rules.ts'

/** The portable ceiling (Linux allows 108, macOS 104, both counting the NUL). */
const MAX_SOCKET_PATH_BYTES = 100

/** Longest preamble the broker will read before giving up on a client. */
const MAX_PREAMBLE_BYTES = 1024

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
  private server: Server | null = null
  private readonly entries: EgressLogEntry[] = []
  private readonly live = new Set<Socket>()
  private readonly socketPath: string
  private readonly rules: readonly EgressRule[]
  private readonly resolve: Readonly<Record<string, string>>

  constructor(socketDir: string, options: EgressBrokerOptions) {
    this.socketPath = join(socketDir, BROKER_SOCKET_NAME)
    this.rules = options.rules
    this.resolve = options.resolve ?? {}
  }

  /** The path the guest side is mounted at; recorded so a review can find it. */
  path(): string {
    return this.socketPath
  }

  async start(): Promise<void> {
    if (Buffer.byteLength(this.socketPath) > MAX_SOCKET_PATH_BYTES) {
      throw new Error(
        `egress socket path is too long for a unix socket (${String(Buffer.byteLength(this.socketPath))} > ${String(MAX_SOCKET_PATH_BYTES)}): ${this.socketPath}`,
      )
    }
    rmSync(this.socketPath, { force: true })
    const server = createServer((guest) => {
      this.accept(guest)
    })
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(this.socketPath, () => {
        server.off('error', reject)
        resolveListen()
      })
    })
    // The guest connects as an unprivileged uid the host does not share.
    chmodSync(this.socketPath, 0o666)
    this.server = server
  }

  /** Read the one-line preamble, decide, then either bridge or refuse. */
  private accept(guest: Socket): void {
    this.live.add(guest)
    let head = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk])
      const newline = head.indexOf(0x0a)
      if (newline === -1) {
        if (head.length > MAX_PREAMBLE_BYTES) {
          this.refuse(guest, 'preamble', 'preamble too long')
        }
        return
      }
      guest.off('data', onData)
      const line = head.subarray(0, newline).toString('utf8').trim()
      const rest = head.subarray(newline + 1)
      const target = /^CONNECT\s+(\S+)$/i.exec(line)?.[1]
      const parsed = target === undefined ? null : parseEgressTarget(target)
      if (parsed === null) {
        this.refuse(guest, line.slice(0, 80), 'malformed preamble')
        return
      }
      const label = `${parsed.host}:${String(parsed.port)}`
      const rule = findEgressRule(this.rules, parsed.host, parsed.port)
      if (rule === null) {
        this.refuse(guest, label, 'not in the allowlist')
        return
      }
      this.bridge(guest, label, rule, parsed.host, parsed.port, rest)
    }
    guest.on('data', onData)
    guest.on('error', () => {
      this.live.delete(guest)
    })
    guest.on('close', () => {
      this.live.delete(guest)
    })
  }

  private refuse(guest: Socket, label: string, reason: string): void {
    this.entries.push({ at: Date.now(), origin: label, event: 'refused', detail: reason })
    guest.end(`DENY ${reason}\n`)
    this.live.delete(guest)
  }

  private bridge(
    guest: Socket,
    label: string,
    rule: EgressRule,
    host: string,
    port: number,
    firstBytes: Buffer,
  ): void {
    let bytesToOrigin = firstBytes.length
    let bytesFromOrigin = 0
    this.entries.push({
      at: Date.now(),
      origin: label,
      event: 'connect',
      detail: `rule ${formatEgressRule(rule)}`,
    })
    const dial = dialAddress(this.resolve, host, port)
    const upstream = connect(dial.port, dial.host)
    this.live.add(upstream)
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
      guest.destroy()
      upstream.destroy()
      this.live.delete(guest)
      this.live.delete(upstream)
    }
    upstream.once('connect', () => {
      guest.write('OK\n')
      if (firstBytes.length > 0) upstream.write(firstBytes)
      guest.on('data', (chunk: Buffer) => {
        bytesToOrigin += chunk.length
      })
      upstream.on('data', (chunk: Buffer) => {
        bytesFromOrigin += chunk.length
      })
      guest.pipe(upstream)
      upstream.pipe(guest)
    })
    guest.on('error', (error) => {
      finish('error', `guest: ${error.message}`)
    })
    upstream.on('error', (error) => {
      // A dial that never connected is the origin's problem, and the guest is
      // still waiting on the preamble reply: tell it, then record it.
      if (!closed && guest.writable) guest.write(`DENY origin unreachable: ${error.message}\n`)
      finish('error', `origin: ${error.message}`)
    })
    guest.on('close', () => {
      finish('close')
    })
    upstream.on('close', () => {
      finish('close')
    })
  }

  log(): EgressLogEntry[] {
    return [...this.entries]
  }

  async stop(): Promise<void> {
    for (const socket of this.live) socket.destroy()
    this.live.clear()
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolveClose) => {
      server.close(() => {
        resolveClose()
      })
    })
  }
}
