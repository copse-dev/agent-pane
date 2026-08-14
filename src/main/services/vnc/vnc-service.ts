import { randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'
import type {
  VncConnection,
  VncDiscoveryHost,
  VncStatusEvent,
  VncTarget,
} from '@shared/types/vnc.ts'
import {
  getSshConnectionManager,
  type SshConnectionManager,
} from '../ssh-workspace/connection-manager.ts'
import type { SshTransport } from '../ssh-workspace/transport.ts'
import { scanListeningPorts, type PortScan } from '../ports/host-scan.ts'
import { dedupePorts, scanCandidates, type ListeningPort } from '../ports/port-scan.ts'

export interface VncConnectionOwner {
  id: number
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

interface ManagedVncConnection {
  public: VncConnection
  owner: VncConnectionOwner
  socket: Socket
  forward?: { transport: SshTransport; localPort: number }
  closing: boolean
}

export const VNC_DATA_CHANNEL = 'vnc:data'
export const VNC_STATUS_CHANNEL = 'vnc:status'

const RFB_BANNER_BYTES = 12
const RFB_PROBE_TIMEOUT_MS = 600
const REMOTE_SCAN_TIMEOUT_MS = 5_000
const LOOPBACK_REACHABLE_ADDRESSES = new Set([
  '0.0.0.0',
  '127.0.0.1',
  '::',
  '::1',
  '*',
  'localhost',
  '',
])

/** Conventional display ports plus listeners whose process name advertises VNC. */
export function isPlausibleVncListener(listener: ListeningPort): boolean {
  return (
    (listener.port >= 5900 && listener.port <= 5999) ||
    /(?:vnc|screen\s*sharing|screensharing|vino)/i.test(listener.command)
  )
}

function rfbBanner(bytes: Buffer): boolean {
  return /^RFB \d{3}\.\d{3}\n$/.test(bytes.subarray(0, RFB_BANNER_BYTES).toString('ascii'))
}

/** Verify that a listener speaks RFB without sending application bytes to it. */
async function probeRfbPort(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    let received = Buffer.alloc(0)
    const settle = (result: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }
    const timer = setTimeout(() => {
      settle(false)
    }, RFB_PROBE_TIMEOUT_MS)
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat(
        [received, chunk],
        Math.min(RFB_BANNER_BYTES, received.length + chunk.length),
      )
      if (received.length >= RFB_BANNER_BYTES) settle(rfbBanner(received))
    })
    socket.once('error', () => {
      settle(false)
    })
    socket.once('close', () => {
      settle(received.length >= RFB_BANNER_BYTES && rfbBanner(received))
    })
  })
}

async function scanRemotePorts(
  connection: Awaited<ReturnType<SshConnectionManager['connect']>>,
): Promise<ListeningPort[]> {
  // Try the superset used across Linux/macOS/Windows SSH hosts. A missing tool
  // returns 127 and falls through; the first usable scanner wins.
  for (const plan of scanCandidates('linux')) {
    try {
      const result = await connection.execArgv([plan.file, ...plan.args], {
        timeoutMs: REMOTE_SCAN_TIMEOUT_MS,
        maxBytes: 2 * 1024 * 1024,
      })
      const parsed = plan.parse(result.stdout)
      if (result.code === 0 || parsed.length > 0) return dedupePorts(parsed)
    } catch {
      // Scanner unavailable on this host — try the next portable candidate.
    }
  }
  return []
}

function targetPort(target: VncTarget): number {
  return target.kind === 'loopback' ? target.port : target.remotePort
}

function connectionFailure(target: VncTarget, error: Error): Error {
  const port = targetPort(target)
  const prefix =
    target.kind === 'ssh'
      ? `The SSH tunnel opened, but no VNC server answered on remote port ${String(port)}`
      : `No VNC server answered on 127.0.0.1:${String(port)}`
  return new Error(`${prefix}: ${error.message}`)
}

/**
 * Owns raw RFB sockets in main. The renderer receives bytes over IPC and cannot
 * open a network connection, preserving the app's `connect-src 'self'` CSP.
 */
export class VncService {
  private readonly connections = new Map<string, ManagedVncConnection>()
  private readonly sshManager: Pick<SshConnectionManager, 'connect'>
  private readonly scanLocal: () => Promise<PortScan>

  constructor(
    sshManager: Pick<SshConnectionManager, 'connect'> = getSshConnectionManager(),
    scanLocal: () => Promise<PortScan> = scanListeningPorts,
  ) {
    this.sshManager = sshManager
    this.scanLocal = scanLocal
  }

  async discover(host: VncDiscoveryHost): Promise<number[]> {
    if (host.kind === 'local') {
      const scan = await this.scanLocal()
      return this.probeCandidates(scan.ports, async (port) => probeRfbPort(port))
    }

    const connection = await this.sshManager.connect(host.hostId)
    const ports = await scanRemotePorts(connection)
    return this.probeCandidates(ports, async (remotePort) => {
      let localPort: number | null = null
      try {
        const forward = await connection.transport.openForward(remotePort)
        localPort = forward.localPort
        return await probeRfbPort(localPort)
      } catch {
        return false
      } finally {
        if (localPort !== null) {
          await connection.transport.closeForward(localPort).catch(() => {})
        }
      }
    })
  }

  async open(target: VncTarget, owner: VncConnectionOwner): Promise<VncConnection> {
    let localPort = targetPort(target)
    let forward: ManagedVncConnection['forward']

    if (target.kind === 'ssh') {
      let connection
      try {
        connection = await this.sshManager.connect(target.hostId)
        const opened = await connection.transport.openForward(target.remotePort)
        localPort = opened.localPort
        forward = { transport: connection.transport, localPort }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Could not open the SSH tunnel: ${message}`, { cause: error })
      }
    }

    const socket = createConnection({ host: '127.0.0.1', port: localPort })
    // A VNC server normally sends its version banner immediately. Pause before
    // awaiting connect so no bytes can outrun the renderer's IPC subscriptions.
    socket.pause()
    try {
      await new Promise<void>((resolve, reject) => {
        const onConnect = (): void => {
          socket.off('error', onError)
          resolve()
        }
        const onError = (error: Error): void => {
          socket.off('connect', onConnect)
          reject(error)
        }
        socket.once('connect', onConnect)
        socket.once('error', onError)
      })
    } catch (error) {
      socket.destroy()
      if (forward) await forward.transport.closeForward(forward.localPort)
      throw connectionFailure(target, error instanceof Error ? error : new Error(String(error)))
    }

    const id = randomUUID()
    const publicConnection: VncConnection = {
      id,
      target,
      localPort,
      status: 'connected',
      writable: false,
    }
    const managed: ManagedVncConnection = {
      public: publicConnection,
      owner,
      socket,
      closing: false,
    }
    if (forward) managed.forward = forward
    this.connections.set(id, managed)
    this.attachSocket(managed)
    return publicConnection
  }

  list(ownerId?: number): VncConnection[] {
    return [...this.connections.values()]
      .filter((connection) => ownerId === undefined || connection.owner.id === ownerId)
      .map((connection) => ({ ...connection.public }))
  }

  start(id: string, ownerId: number): void {
    this.requireOwned(id, ownerId).socket.resume()
  }

  send(id: string, ownerId: number, bytes: Uint8Array): void {
    const connection = this.requireOwned(id, ownerId)
    if (connection.public.status !== 'connected') throw new Error('VNC connection is not open')
    connection.socket.write(bytes)
  }

  async close(id: string, ownerId: number): Promise<void> {
    await this.closeManaged(this.requireOwned(id, ownerId), 'closed')
  }

  async closeOwner(ownerId: number): Promise<void> {
    const owned = [...this.connections.values()].filter(
      (connection) => connection.owner.id === ownerId,
    )
    await Promise.allSettled(owned.map((connection) => this.closeManaged(connection, 'closed')))
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.connections.values()].map((connection) => this.closeManaged(connection, 'closed')),
    )
  }

  private requireOwned(id: string, ownerId: number): ManagedVncConnection {
    const connection = this.connections.get(id)
    if (!connection || connection.owner.id !== ownerId) {
      throw new Error('Unknown VNC connection')
    }
    return connection
  }

  private async probeCandidates(
    listeners: readonly ListeningPort[],
    probe: (port: number) => Promise<boolean>,
  ): Promise<number[]> {
    const candidates = [
      ...new Set(
        listeners
          .filter((listener) => LOOPBACK_REACHABLE_ADDRESSES.has(listener.address))
          .filter(isPlausibleVncListener)
          .map((listener) => listener.port),
      ),
    ].sort((left, right) => left - right)
    const discovered: number[] = []
    // Keep the probe sequential: remote candidates temporarily allocate SSH
    // forwards, and discovery should never fan out dozens of control commands.
    for (const port of candidates) {
      if (await probe(port)) discovered.push(port)
    }
    return discovered
  }

  private attachSocket(connection: ManagedVncConnection): void {
    connection.socket.on('data', (chunk: Buffer) => {
      if (!connection.owner.isDestroyed()) {
        // Copy the exact view: Buffer instances may share a larger pooled backing
        // ArrayBuffer, which must not leak unrelated bytes across contextBridge.
        connection.owner.send(VNC_DATA_CHANNEL, connection.public.id, Uint8Array.from(chunk))
      }
    })
    connection.socket.on('error', (error) => {
      void this.closeManaged(connection, 'error', error.message)
    })
    connection.socket.on('close', () => {
      if (!connection.closing) {
        void this.closeManaged(connection, 'error', 'The VNC server closed the connection')
      }
    })
  }

  private async closeManaged(
    connection: ManagedVncConnection,
    status: 'closed' | 'error',
    lastError?: string,
  ): Promise<void> {
    if (connection.closing) return
    connection.closing = true
    connection.public.status = status
    if (lastError) connection.public.lastError = lastError
    connection.socket.destroy()
    if (connection.forward) {
      await connection.forward.transport.closeForward(connection.forward.localPort).catch(() => {})
    }
    this.connections.delete(connection.public.id)
    if (!connection.owner.isDestroyed()) {
      const event: VncStatusEvent = { id: connection.public.id, status }
      if (lastError) event.lastError = lastError
      connection.owner.send(VNC_STATUS_CHANNEL, event)
    }
  }
}

let service: VncService | null = null

export function getVncService(): VncService {
  service ??= new VncService()
  return service
}

export function resetVncServiceForTests(): void {
  service = null
}
