import type { SshWorkspaceHost, SshExecResult } from '@shared/types/ssh-workspace.ts'

export interface SshExecOptions {
  cwd?: string
  env?: Record<string, string>
  stdin?: string
  signal?: AbortSignal
  maxBytes?: number
  timeoutMs?: number
}

export interface SshTransport {
  connect(): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  openForward(remotePort: number): Promise<{ localPort: number }>
  closeForward(localPort: number): Promise<void>
  /** Stream a remote file directly to local disk without the command-output cap. */
  fetchFile(remotePath: string, localPath: string, options?: SshExecOptions): Promise<void>
  /** Read a remote file size before transferring its bytes. */
  sizeOf(remotePath: string, options?: SshExecOptions): Promise<number>
  execArgv(argv: string[], options?: SshExecOptions): Promise<SshExecResult>
  execShell(command: string, options?: SshExecOptions): Promise<SshExecResult>
}

export type SshTransportFactory = (host: SshWorkspaceHost) => SshTransport
