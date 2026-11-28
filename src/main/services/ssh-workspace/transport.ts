import type { SshWorkspaceHost, SshExecResult } from '@shared/types/ssh-workspace.ts'

export interface SshExecOptions {
  cwd?: string
  env?: Record<string, string>
  stdin?: string
  signal?: AbortSignal
  maxBytes?: number
  timeoutMs?: number
}

export interface SshConnectOptions {
  /**
   * Never raise a prompt. The attempt succeeds only where no password, key
   * passphrase or host-key question is needed (an agent, an unencrypted key),
   * and otherwise fails. Used by reconnects that no user action started.
   */
  quiet?: boolean
}

export interface SshTransport {
  connect(options?: SshConnectOptions): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  /**
   * Whether the connection this transport reported as connected still exists.
   * Must be cheap and must never authenticate or prompt: it runs on a timer.
   */
  checkAlive(): Promise<boolean>
  openForward(remotePort: number): Promise<{ localPort: number }>
  closeForward(localPort: number): Promise<void>
  /**
   * Forward a local unix socket at `localPath` to the one at `remotePath` on
   * the host, over the existing connection. Replaces whatever is at
   * `localPath`.
   */
  openSocketForward(localPath: string, remotePath: string): Promise<void>
  closeSocketForward(localPath: string): Promise<void>
  /** Stream a remote file directly to local disk without the command-output cap. */
  fetchFile(remotePath: string, localPath: string, options?: SshExecOptions): Promise<void>
  /** Read a remote file size before transferring its bytes. */
  sizeOf(remotePath: string, options?: SshExecOptions): Promise<number>
  execArgv(argv: string[], options?: SshExecOptions): Promise<SshExecResult>
  execShell(command: string, options?: SshExecOptions): Promise<SshExecResult>
}

export type SshTransportFactory = (host: SshWorkspaceHost) => SshTransport
