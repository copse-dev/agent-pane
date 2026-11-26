import { isDeepStrictEqual } from 'node:util'
import type {
  SshCapabilityReport,
  SshConnectionState,
  SshConnectionStatus,
  SshExecResult,
  SshWorkspaceHost,
} from '@shared/types/ssh-workspace.ts'
import { findConfiguredSshHost, displayTarget } from './hosts.ts'
import { OpenSshTransport } from './openssh-transport.ts'
import { probeSshCapabilities } from './capability-probe.ts'
import type { SshExecOptions, SshTransport, SshTransportFactory } from './transport.ts'
import { errorMessage } from '@shared/errors.ts'

export interface SshConnection {
  host: SshWorkspaceHost
  transport: SshTransport
  capabilities?: SshCapabilityReport
  execArgv(argv: string[], options?: SshExecOptions): Promise<SshExecResult>
  execShell(command: string, options?: SshExecOptions): Promise<SshExecResult>
}

type ConnectionListener = (states: SshConnectionState[]) => void

interface ManagedConnection {
  host: SshWorkspaceHost
  transport: SshTransport
  status: SshConnectionStatus
  capabilities?: SshCapabilityReport
  /**
   * Whether this connection forwards the user's SSH agent, from Copse's
   * setting or the user's own `~/.ssh/config`. Resolved once per connection.
   */
  forwardsAgent?: boolean
  lastError?: string
  /** Quiet reconnects tried since the link was found gone. */
  quietAttempts: number
  /** Earliest time the next quiet reconnect may start. */
  nextQuietAttemptAt: number
}

/** How often a host shown as connected is asked whether it still is. */
export const SSH_LIVENESS_INTERVAL_MS = 30_000

/**
 * Waits between quiet reconnects after a link is found gone. The first is
 * immediate; the rest cover a laptop waking before its network does. After
 * the last one Copse stops trying and leaves the banner's Reconnect button,
 * so a host that is really gone is not dialled for ever.
 */
export const SSH_QUIET_RECONNECT_DELAYS_MS: readonly number[] = [
  0, 30_000, 60_000, 120_000, 300_000, 300_000,
]

/** OpenSSH's own exit status when the connection, not the remote command, failed. */
const SSH_TRANSPORT_FAILURE_EXIT = 255

export interface SshConnectionManagerOptions {
  now?: () => number
  /** Interval for the liveness timer; `0` leaves checking to explicit `checkLiveness()` calls. */
  livenessIntervalMs?: number
}

let transportFactory: SshTransportFactory = (host): SshTransport => new OpenSshTransport(host)

export function setSshTransportFactory(factory: SshTransportFactory): void {
  transportFactory = factory
}

export function resetSshTransportFactory(): void {
  transportFactory = (host: SshWorkspaceHost): SshTransport => new OpenSshTransport(host)
}

resetSshTransportFactory()

async function disconnectTransportBestEffort(transport: SshTransport): Promise<void> {
  try {
    await transport.disconnect()
  } catch {
    // ignore cleanup failures
  }
}

/** Whether the host is still saved exactly as it was when its transport was built. */
function savedHostUnchanged(hostId: string, host: SshWorkspaceHost): boolean {
  const saved = findConfiguredSshHost(hostId)
  return saved !== undefined && isDeepStrictEqual(saved, host)
}

export class SshConnectionManager {
  private readonly connections = new Map<string, ManagedConnection>()
  private readonly connectPromises = new Map<string, Promise<SshConnection>>()
  private readonly listeners = new Set<ConnectionListener>()
  private readonly verifying = new Map<string, Promise<void>>()
  private readonly now: () => number
  private readonly livenessIntervalMs: number
  private livenessTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: SshConnectionManagerOptions = {}) {
    this.now = options.now ?? Date.now
    this.livenessIntervalMs = options.livenessIntervalMs ?? SSH_LIVENESS_INTERVAL_MS
  }

  onChange(listener: ConnectionListener): () => void {
    this.listeners.add(listener)
    listener(this.listStates())
    return () => {
      this.listeners.delete(listener)
    }
  }

  listStates(): SshConnectionState[] {
    return [...this.connections.values()].map((entry) => {
      const state: SshConnectionState = {
        hostId: entry.host.id,
        status: entry.status,
        label: entry.host.label,
        target: displayTarget(entry.host),
      }
      if (entry.capabilities) state.capabilities = entry.capabilities
      if (entry.lastError) state.lastError = entry.lastError
      return state
    })
  }

  private emit(): void {
    this.syncLivenessTimer()
    const states = this.listStates()
    for (const listener of this.listeners) listener(states)
  }

  /**
   * Whether the connection to this host forwards the user's SSH agent, as
   * resolved when it connected; `undefined` before Copse has connected to it.
   */
  forwardsAgent(hostId: string): boolean | undefined {
    return this.connections.get(hostId)?.forwardsAgent
  }

  getConnection(hostId: string): SshConnection | null {
    const entry = this.connections.get(hostId)
    if (!entry || entry.status !== 'connected') return null
    return this.wrap(entry)
  }

  private wrap(entry: ManagedConnection): SshConnection {
    return wrapConnection(entry, () => {
      this.noteTransportFailure(entry.host.id)
    })
  }

  /** A command on this host failed at the connection: check it now, not at the next tick. */
  noteTransportFailure(hostId: string): void {
    void this.verify(hostId)
  }

  /**
   * Ask every host whether its connection is still there, and try to restore
   * the ones that are not. Runs on a timer, so nothing here may prompt.
   */
  async checkLiveness(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((hostId) => this.verify(hostId)))
  }

  private verify(hostId: string): Promise<void> {
    const inFlight = this.verifying.get(hostId)
    if (inFlight) return inFlight
    const run = this.verifyInternal(hostId).finally(() => {
      this.verifying.delete(hostId)
    })
    this.verifying.set(hostId, run)
    return run
  }

  private async verifyInternal(hostId: string): Promise<void> {
    const entry = this.connections.get(hostId)
    // A connect the user started owns the entry until it settles, and a failed
    // connect (`error`) waits for the user: it may need a prompt we must not raise.
    if (!entry || this.connectPromises.has(hostId)) return
    if (entry.status !== 'connected' && entry.status !== 'disconnected') return
    // `connect` and `disconnect` wait for this check before touching the entry,
    // so it can only have been replaced by the time an await below returns.
    const isCurrent = (): boolean => this.connections.get(hostId) === entry

    const alive = await entry.transport.checkAlive().catch(() => false)
    if (!isCurrent()) return
    if (alive) {
      // A command can rebuild the master on its own (`ControlMaster=auto`).
      if (entry.status !== 'connected') this.markConnected(entry)
      return
    }

    if (entry.status === 'connected') {
      entry.status = 'disconnected'
      entry.quietAttempts = 0
      entry.nextQuietAttemptAt = this.now()
      this.emit()
    }
    // A quiet reconnect rebuilds the master from the host as it was saved when
    // the user connected. Once they have edited it (say, unticked Forward
    // agent), leave the reconnect to them: Reconnect builds from the saved entry.
    if (!savedHostUnchanged(hostId, entry.host)) return
    const delays = SSH_QUIET_RECONNECT_DELAYS_MS
    if (entry.quietAttempts >= delays.length || this.now() < entry.nextQuietAttemptAt) return
    entry.quietAttempts += 1
    entry.nextQuietAttemptAt = this.now() + (delays[entry.quietAttempts] ?? 0)
    try {
      await entry.transport.connect({ quiet: true })
    } catch {
      return
    }
    if (!isCurrent()) return
    // An edit can also land while that connect runs. The new master then
    // carries the old options, so close it rather than report it connected.
    if (!savedHostUnchanged(hostId, entry.host)) {
      await disconnectTransportBestEffort(entry.transport)
      return
    }
    this.markConnected(entry)
  }

  private markConnected(entry: ManagedConnection): void {
    entry.status = 'connected'
    entry.quietAttempts = 0
    entry.nextQuietAttemptAt = 0
    delete entry.lastError
    this.emit()
  }

  private syncLivenessTimer(): void {
    const wanted =
      this.livenessIntervalMs > 0 &&
      [...this.connections.values()].some(
        (entry) => entry.status === 'connected' || entry.status === 'disconnected',
      )
    if (wanted && !this.livenessTimer) {
      this.livenessTimer = setInterval(() => {
        void this.checkLiveness()
      }, this.livenessIntervalMs)
      // Never hold the process open for a liveness check.
      this.livenessTimer.unref()
    } else if (!wanted && this.livenessTimer) {
      clearInterval(this.livenessTimer)
      this.livenessTimer = null
    }
  }

  /** Stop the liveness timer. Connections themselves are left as they are. */
  dispose(): void {
    if (this.livenessTimer) clearInterval(this.livenessTimer)
    this.livenessTimer = null
  }

  async connect(hostId: string): Promise<SshConnection> {
    const inFlight = this.connectPromises.get(hostId)
    if (inFlight) return inFlight

    const existing = this.connections.get(hostId)
    if (existing?.status === 'connected') return this.wrap(existing)

    const promise = this.connectAfterVerify(hostId)
    this.connectPromises.set(hostId, promise)
    try {
      return await promise
    } finally {
      this.connectPromises.delete(hostId)
    }
  }

  /**
   * A quiet reconnect may be starting a master on this host's control socket.
   * Let it settle first, so two masters never race for one socket, and use
   * the connection it restored if it did.
   */
  private async connectAfterVerify(hostId: string): Promise<SshConnection> {
    await this.verifying.get(hostId)
    const existing = this.connections.get(hostId)
    if (existing?.status === 'connected') return this.wrap(existing)
    return this.connectInternal(hostId, existing)
  }

  private async connectInternal(
    hostId: string,
    existing: ManagedConnection | undefined,
  ): Promise<SshConnection> {
    if (existing && existing.status !== 'connected') {
      await disconnectTransportBestEffort(existing.transport)
    }

    const host = findConfiguredSshHost(hostId)
    if (!host) throw new Error(`Unknown SSH host: ${hostId}`)

    const transport = transportFactory(host)
    const managed: ManagedConnection = {
      host,
      transport,
      status: 'connecting',
      quietAttempts: 0,
      nextQuietAttemptAt: 0,
    }
    this.connections.set(hostId, managed)
    this.emit()

    try {
      await transport.connect()
      managed.status = 'connected'
      delete managed.lastError
      const [capabilities, forwardsAgent] = await Promise.all([
        probeSshCapabilities(transport),
        resolveForwardsAgent(host, transport),
      ])
      managed.capabilities = capabilities
      managed.forwardsAgent = forwardsAgent
      this.emit()
      return this.wrap(managed)
    } catch (err) {
      const message = errorMessage(err)
      managed.status = 'error'
      managed.lastError = message
      await disconnectTransportBestEffort(transport)
      this.emit()
      throw err instanceof Error ? err : new Error(message)
    }
  }

  async disconnect(hostId: string): Promise<void> {
    await this.verifying.get(hostId)
    const entry = this.connections.get(hostId)
    if (!entry) return
    try {
      await entry.transport.disconnect()
    } finally {
      this.connections.delete(hostId)
      this.emit()
    }
  }

  async reconnect(hostId: string): Promise<SshConnection> {
    await this.disconnect(hostId)
    return this.connect(hostId)
  }
}

/**
 * Copse's own `forwardAgent` setting, or else what OpenSSH resolves from the
 * user's config. A failed lookup is not an error: the connection works, and
 * the setting alone is what Copse knew before it asked.
 */
async function resolveForwardsAgent(
  host: SshWorkspaceHost,
  transport: SshTransport,
): Promise<boolean> {
  if (host.forwardAgent === true) return true
  try {
    return (await transport.resolveForwardAgent()) === true
  } catch {
    return false
  }
}

function wrapConnection(entry: ManagedConnection, onTransportFailure: () => void): SshConnection {
  // OpenSSH exits 255 when the connection itself failed. That is the earliest
  // sign of a dropped link, so check now rather than at the next timer tick.
  const observe = async (run: Promise<SshExecResult>): Promise<SshExecResult> => {
    const result = await run
    if (result.code === SSH_TRANSPORT_FAILURE_EXIT) onTransportFailure()
    return result
  }
  const conn: SshConnection = {
    host: entry.host,
    transport: entry.transport,
    execArgv: (argv, options) => observe(entry.transport.execArgv(argv, options)),
    execShell: (command, options) => observe(entry.transport.execShell(command, options)),
  }
  if (entry.capabilities) conn.capabilities = entry.capabilities
  return conn
}

let manager: SshConnectionManager | null = null

export function getSshConnectionManager(): SshConnectionManager {
  manager ??= new SshConnectionManager()
  return manager
}

export function resetSshConnectionManagerForTests(): void {
  manager?.dispose()
  manager = null
  resetSshTransportFactory()
}
