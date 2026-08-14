export type VncTarget =
  | { kind: 'loopback'; port: number }
  | { kind: 'ssh'; hostId: string; remotePort: number; display?: string | undefined }

export type VncConnectionStatus = 'connecting' | 'connected' | 'closed' | 'error'

export interface VncConnection {
  id: string
  target: VncTarget
  /** Local end of the SSH tunnel, or the loopback port itself. */
  localPort: number
  status: VncConnectionStatus
  /** V1 is deliberately view-only. Later phases may make this true. */
  writable: boolean
  lastError?: string
}

export interface VncStatusEvent {
  id: string
  status: VncConnectionStatus
  lastError?: string
}
