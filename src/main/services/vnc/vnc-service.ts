import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP, createConnection, type Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import Bonjour, { type Service } from 'bonjour-service'
import {
  isLoopbackHostname,
  isPrivateOrLinkLocalHost,
  normalizeHostname,
} from '@copse/llm/credential-url.ts'
import type {
  VncConnection,
  VncDiscoveryHost,
  VncNearbyServer,
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
const RFB_PROBE_TIMEOUT_MS = 2_000
const REMOTE_SCAN_TIMEOUT_MS = 5_000
const NEARBY_DISCOVERY_MS = 1_500
const SSH_HOST_RESOLUTION_TIMEOUT_MS = 1_500
const DEFAULT_RFB_PORT = 5900
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

function addressForPolicy(address: string): string {
  return normalizeHostname(address).split('%')[0] ?? ''
}

function isLanAddress(address: string): boolean {
  const normalized = addressForPolicy(address)
  return !isLoopbackHostname(normalized) && isPrivateOrLinkLocalHost(normalized)
}

function localInterfaceAddresses(): Set<string> {
  const addresses = new Set<string>()
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) addresses.add(addressForPolicy(entry.address))
  }
  return addresses
}

function nearbyServer(
  service: Service,
  localAddresses: ReadonlySet<string>,
): VncNearbyServer | null {
  const addresses = [...new Set((service.addresses ?? []).filter(isLanAddress))]
  if (
    addresses.length > 0 &&
    addresses.every((address) => localAddresses.has(addressForPolicy(address)))
  ) {
    return null
  }
  const host = normalizeHostname(service.host)
  if (addresses.length === 0 && (!host || !host.endsWith('.local'))) return null
  return { name: service.name, host, port: service.port, addresses }
}

/** Browse for `_rfb._tcp.local` advertisements without sweeping the subnet. */
export async function discoverNearbyVncServers(): Promise<VncNearbyServer[]> {
  return new Promise<VncNearbyServer[]>((resolve, reject) => {
    const discovered = new Map<string, VncNearbyServer>()
    const localAddresses = localInterfaceAddresses()
    let discoveryError: Error | null = null
    const bonjour = new Bonjour(undefined, (error: unknown) => {
      discoveryError = error instanceof Error ? error : new Error(String(error))
    })
    const browser = bonjour.find({ type: 'rfb', protocol: 'tcp' }, (service) => {
      const server = nearbyServer(service, localAddresses)
      if (server) discovered.set(`${server.host}:${String(server.port)}`, server)
    })
    setTimeout(() => {
      browser.stop()
      bonjour.destroy()
      const servers = [...discovered.values()].sort((left, right) =>
        left.name.localeCompare(right.name),
      )
      if (servers.length === 0 && discoveryError) reject(discoveryError)
      else resolve(servers)
    }, NEARBY_DISCOVERY_MS)
  })
}

type LookupHost = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>

function hostnameFromSshTarget(rawHost: string): string {
  const withoutUser = rawHost.trim().split('@').at(-1) ?? ''
  return normalizeHostname(withoutUser.replace(/^\[|\]$/g, ''))
}

/** Resolve a configured SSH target for identity matching, never for connection routing. */
export async function resolveVncSshHostAddresses(
  rawHost: string,
  lookupHost: LookupHost = lookup,
  timeoutMs = SSH_HOST_RESOLUTION_TIMEOUT_MS,
): Promise<string[]> {
  const host = hostnameFromSshTarget(rawHost)
  if (!host) return []
  if (isIP(host) !== 0) return [addressForPolicy(host)]

  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const resolved = await Promise.race([
      lookupHost(host, { all: true, verbatim: true }),
      new Promise<Array<{ address: string; family: number }>>((resolve) => {
        timeout = setTimeout(() => {
          resolve([])
        }, timeoutMs)
      }),
    ])
    return [...new Set(resolved.map((entry) => addressForPolicy(entry.address)).filter(Boolean))]
  } catch {
    return []
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

/** Resolve once and pin the socket to a LAN address, avoiding a second DNS lookup. */
export async function resolveVncNetworkHost(
  rawHost: string,
  lookupHost: LookupHost = lookup,
): Promise<string> {
  const host = normalizeHostname(rawHost)
  if (!host) throw new Error('Enter a hostname or IP address')
  if (isIP(host) !== 0) {
    if (!isLanAddress(host)) {
      throw new Error('Direct VNC is limited to private or link-local network addresses')
    }
    return host
  }

  const resolved = await lookupHost(host, { all: true, verbatim: true })
  if (resolved.length === 0 || resolved.some((entry) => !isLanAddress(entry.address))) {
    throw new Error('The hostname must resolve only to private or link-local network addresses')
  }
  return resolved.find((entry) => entry.family === 4)?.address ?? resolved[0]?.address ?? host
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
  const remoteOs = connection.capabilities?.os.toLowerCase() ?? ''
  const platform: NodeJS.Platform = remoteOs.includes('darwin')
    ? 'darwin'
    : remoteOs.includes('windows')
      ? 'win32'
      : 'linux'
  for (const plan of scanCandidates(platform)) {
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

function withDefaultRfbFallback(listeners: readonly ListeningPort[]): ListeningPort[] {
  const hasReachableCandidate = listeners.some(
    (listener) =>
      LOOPBACK_REACHABLE_ADDRESSES.has(listener.address) && isPlausibleVncListener(listener),
  )
  if (hasReachableCandidate) return [...listeners]
  return [
    ...listeners,
    { port: DEFAULT_RFB_PORT, pid: null, command: 'Screen Sharing', address: '127.0.0.1' },
  ]
}

function targetPort(target: VncTarget): number {
  if (target.kind === 'loopback' || target.kind === 'network') return target.port
  return target.remotePort
}

function connectionFailure(target: VncTarget, error: Error): Error {
  const port = targetPort(target)
  const code = 'code' in error && typeof error.code === 'string' ? error.code : null
  if (target.kind === 'network' && code === 'ECONNREFUSED') {
    return new Error(
      `Screen Sharing is not accepting connections on ${target.host}:${String(port)}. Turn on General → Sharing → Screen Sharing on the remote Mac and allow VNC viewers.`,
    )
  }
  if (
    target.kind === 'network' &&
    (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH')
  ) {
    return new Error(
      `Could not reach ${target.host}:${String(port)}. Check that the Mac is awake, on this network, and has Screen Sharing enabled.`,
    )
  }
  const prefix =
    target.kind === 'ssh'
      ? `The SSH tunnel opened, but no VNC server answered on remote port ${String(port)}`
      : target.kind === 'network'
        ? `No VNC server answered on ${target.host}:${String(port)}`
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
  private readonly discoverNearbyImpl: () => Promise<VncNearbyServer[]>
  private readonly resolveNetworkHost: (host: string) => Promise<string>

  constructor(
    sshManager: Pick<SshConnectionManager, 'connect'> = getSshConnectionManager(),
    scanLocal: () => Promise<PortScan> = scanListeningPorts,
    discoverNearby: () => Promise<VncNearbyServer[]> = discoverNearbyVncServers,
    resolveNetworkHost: (host: string) => Promise<string> = resolveVncNetworkHost,
  ) {
    this.sshManager = sshManager
    this.scanLocal = scanLocal
    this.discoverNearbyImpl = discoverNearby
    this.resolveNetworkHost = resolveNetworkHost
  }

  async discover(host: VncDiscoveryHost): Promise<number[]> {
    if (host.kind === 'local') {
      const scan = await this.scanLocal()
      return this.probeCandidates(withDefaultRfbFallback(scan.ports), async (port) =>
        probeRfbPort(port),
      )
    }

    const connection = await this.sshManager.connect(host.hostId)
    const ports = withDefaultRfbFallback(await scanRemotePorts(connection))
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

  async discoverNearby(): Promise<VncNearbyServer[]> {
    if (seededNearbyServers !== null) return seededNearbyServers.map((server) => ({ ...server }))
    return this.discoverNearbyImpl()
  }

  async open(target: VncTarget, owner: VncConnectionOwner): Promise<VncConnection> {
    let localPort = targetPort(target)
    let socketHost = '127.0.0.1'
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
    } else if (target.kind === 'network') {
      socketHost = await this.resolveNetworkHost(target.host)
    }

    const socket = createConnection({ host: socketHost, port: localPort })
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
let seededNearbyServers: VncNearbyServer[] | null = null

export function getVncService(): VncService {
  service ??= new VncService()
  return service
}

export function resetVncServiceForTests(): void {
  service = null
  seededNearbyServers = null
}

export function setSeededVncNearbyServersForTests(servers: VncNearbyServer[]): void {
  seededNearbyServers = servers.map((server) => ({ ...server, addresses: [...server.addresses] }))
}
