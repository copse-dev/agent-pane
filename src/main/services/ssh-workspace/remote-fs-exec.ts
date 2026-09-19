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
  const transport = await connectedTransport(hostId)
  const options: { cwd: string; stdin?: string } = { cwd: remoteRoot }
  if (stdin !== undefined) options.stdin = stdin
  return transport.execShell(shellCommand, options)
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
