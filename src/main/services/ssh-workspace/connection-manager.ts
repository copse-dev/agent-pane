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
  lastError?: string
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

export class SshConnectionManager {
  private readonly connections = new Map<string, ManagedConnection>()
  private readonly connectPromises = new Map<string, Promise<SshConnection>>()
  private readonly listeners = new Set<ConnectionListener>()

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
    const states = this.listStates()
    for (const listener of this.listeners) listener(states)
  }

  getConnection(hostId: string): SshConnection | null {
    const entry = this.connections.get(hostId)
    if (!entry || entry.status !== 'connected') return null
    return wrapConnection(entry)
  }

  async connect(hostId: string): Promise<SshConnection> {
    const inFlight = this.connectPromises.get(hostId)
    if (inFlight) return inFlight

    const existing = this.connections.get(hostId)
    if (existing?.status === 'connected') return wrapConnection(existing)

    const promise = this.connectInternal(hostId, existing)
    this.connectPromises.set(hostId, promise)
    try {
      return await promise
    } finally {
      this.connectPromises.delete(hostId)
    }
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
    }
    this.connections.set(hostId, managed)
    this.emit()

    try {
      await transport.connect()
      managed.status = 'connected'
      delete managed.lastError
      managed.capabilities = await probeSshCapabilities(transport)
      this.emit()
      return wrapConnection(managed)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      managed.status = 'error'
      managed.lastError = message
      await disconnectTransportBestEffort(transport)
      this.emit()
      throw err instanceof Error ? err : new Error(message)
    }
  }

  async disconnect(hostId: string): Promise<void> {
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

function wrapConnection(entry: ManagedConnection): SshConnection {
  const conn: SshConnection = {
    host: entry.host,
    transport: entry.transport,
    execArgv: (argv, options) => entry.transport.execArgv(argv, options),
    execShell: (command, options) => entry.transport.execShell(command, options),
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
  manager = null
  resetSshTransportFactory()
}
