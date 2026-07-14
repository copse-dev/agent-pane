/** Persisted SSH workspace host entry (`sshWorkspaceHosts` setting). */
export interface SshWorkspaceHost {
  id: string
  label: string
  /** Hostname or alias from ~/.ssh/config. */
  host: string
  port?: number
  user?: string
  identityFile?: string
  /** Opt-in agent forwarding for this host (default off). */
  forwardAgent?: boolean
}

/** Host alias discovered in the user's ~/.ssh/config. */
export interface SshConfigAlias {
  alias: string
  hostname?: string
  user?: string
  port?: number
  identityFile?: string
}

export type SshConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface SshCapabilityReport {
  os: string
  arch: string
  shell: string | null
  git: boolean
  rg: boolean
  inotifywait: boolean
  warnings: string[]
}

export interface SshConnectionState {
  hostId: string
  status: SshConnectionStatus
  label: string
  /** Display target, e.g. `user@host`. */
  target: string
  capabilities?: SshCapabilityReport
  lastError?: string
}

export interface SshExecResult {
  stdout: string
  stderr: string
  code: number
}
