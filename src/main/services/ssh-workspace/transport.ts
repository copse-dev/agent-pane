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
  execArgv(argv: string[], options?: SshExecOptions): Promise<SshExecResult>
  execShell(command: string, options?: SshExecOptions): Promise<SshExecResult>
}

export type SshTransportFactory = (host: SshWorkspaceHost) => SshTransport
