/**
 * Host-side egress broker for a container run (`docs/plans/thread-in-container.md`).
 *
 * The guest has no network interface. For each origin the run allowlists, the
 * host listens on a unix socket in the run directory; inside the guest the
 * entrypoint binds the origin's name to loopback and forwards that port into
 * the socket. The broker is therefore the *only* way bytes leave the guest, and
 * it forwards each connection to exactly the origin the socket was created for
 * — the guest cannot pick a destination, only a socket the host already named.
 *
 * Everything else is denied by construction (no route), which is why there is
 * no "denied" log here: the record lists what was reachable and what was used.
 * Per-connection byte counts are recorded so a run that moved far more data
 * than a model conversation needs stands out in review.
 */
import { chmodSync, rmSync } from 'node:fs'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { join } from 'node:path'

export interface EgressOrigin {
  /** The name the guest resolves; the broker dials this too unless `connectHost` says otherwise. */
  host: string
  port: number
  /** Address the host dials for this origin, when the guest-facing name is not resolvable here. */
  connectHost?: string
}

export interface EgressLogEntry {
  at: number
  origin: string
  event: 'connect' | 'close' | 'error'
  bytesToOrigin?: number
  bytesFromOrigin?: number
  detail?: string
}

/** The portable ceiling (Linux allows 108, macOS 104, both counting the NUL). */
const MAX_SOCKET_PATH_BYTES = 100

export class EgressBroker {
  private readonly servers: Server[] = []
  private readonly entries: EgressLogEntry[] = []
  private readonly live = new Set<Socket>()

  private readonly socketDir: string
  private readonly origins: readonly EgressOrigin[]
  private readonly socketName: (origin: EgressOrigin) => string

  constructor(
    socketDir: string,
    origins: readonly EgressOrigin[],
    socketName: (origin: EgressOrigin) => string,
  ) {
    this.socketDir = socketDir
    this.origins = origins
    this.socketName = socketName
  }

  async start(): Promise<void> {
    for (const origin of this.origins) {
      const path = join(this.socketDir, this.socketName(origin))
      if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) {
        throw new Error(
          `egress socket path is too long for a unix socket (${String(Buffer.byteLength(path))} > ${String(MAX_SOCKET_PATH_BYTES)}): ${path}`,
        )
      }
      rmSync(path, { force: true })
      const server = createServer((guest) => {
        this.bridge(origin, guest)
      })
      await new Promise<void>((resolveListen, reject) => {
        server.once('error', reject)
        server.listen(path, () => {
          server.off('error', reject)
          resolveListen()
        })
      })
      // The guest connects as an unprivileged uid the host does not share.
      chmodSync(path, 0o666)
      this.servers.push(server)
    }
  }

  private bridge(origin: EgressOrigin, guest: Socket): void {
    const label = `${origin.host}:${String(origin.port)}`
    let bytesToOrigin = 0
    let bytesFromOrigin = 0
    this.entries.push({ at: Date.now(), origin: label, event: 'connect' })
    const upstream = connect(origin.port, origin.connectHost ?? origin.host)
    this.live.add(guest)
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
    guest.on('data', (chunk: Buffer) => {
      bytesToOrigin += chunk.length
    })
    upstream.on('data', (chunk: Buffer) => {
      bytesFromOrigin += chunk.length
    })
    guest.pipe(upstream)
    upstream.pipe(guest)
    guest.on('error', (error) => {
      finish('error', `guest: ${error.message}`)
    })
    upstream.on('error', (error) => {
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
    await Promise.all(
      this.servers.map(
        (server) =>
          new Promise<void>((resolveClose) => {
            server.close(() => {
              resolveClose()
            })
          }),
      ),
    )
    this.servers.length = 0
  }
}
