import type { SshExecResult } from '@shared/types/ssh-workspace.ts'
import { getSshConnectionManager } from './connection-manager.ts'
import type { SshExecOptions, SshTransport } from './transport.ts'

type RemoteFileOptions = Pick<SshExecOptions, 'signal' | 'timeoutMs' | 'maxBytes'>

async function connectedTransport(hostId: string): Promise<SshTransport> {
  const manager = getSshConnectionManager()
  const connection = manager.getConnection(hostId) ?? (await manager.connect(hostId))
  return connection.transport
}

export async function execOnSshHost(
  hostId: string,
  remoteRoot: string,
  shellCommand: string,
  stdin?: string,
): Promise<SshExecResult> {
  const manager = getSshConnectionManager()
  // Through the connection rather than its bare transport, so a command that
  // fails at the link is what tells the manager to check the link.
  const connection = manager.getConnection(hostId) ?? (await manager.connect(hostId))
  const options: { cwd: string; stdin?: string } = { cwd: remoteRoot }
  if (stdin !== undefined) options.stdin = stdin
  return connection.execShell(shellCommand, options)
}

/**
 * Run a command only if the host is connected right now; `null` when it is not.
 *
 * For work no user action started, such as polling. It never opens a
 * connection, so a timer can never be the reason an SSH prompt appears: a lost
 * host stays quiet until the user, or a command they ran, reconnects it.
 */
export async function execOnConnectedSshHost(
  hostId: string,
  remoteRoot: string,
  shellCommand: string,
): Promise<SshExecResult | null> {
  const connection = getSshConnectionManager().getConnection(hostId)
  if (!connection) return null
  return connection.execShell(shellCommand, { cwd: remoteRoot })
}

/** Stream remote bytes to disk without routing them through capped command output. */
export async function fetchFileOnSshHost(
  hostId: string,
  remoteRoot: string,
  remotePath: string,
  localPath: string,
  options: RemoteFileOptions = {},
): Promise<void> {
  const transport = await connectedTransport(hostId)
  await transport.fetchFile(remotePath, localPath, { ...options, cwd: remoteRoot })
}

/** Probe the byte size before deciding whether a remote transfer is allowed. */
export async function sizeOfFileOnSshHost(
  hostId: string,
  remoteRoot: string,
  remotePath: string,
  options: RemoteFileOptions = {},
): Promise<number> {
  const transport = await connectedTransport(hostId)
  return transport.sizeOf(remotePath, { ...options, cwd: remoteRoot })
}
