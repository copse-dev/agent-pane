/** Session-only metadata; never headers, command arguments, bodies, or credentials. */
export interface NetworkActivityRow {
  id: number
  source: 'command' | 'container' | 'sandbox'
  label: string
  target: string | null
  threadId: string | null
  projectId: string | null
  startedAt: number
  endedAt: number | null
  status:
    | 'running'
    | 'connecting'
    | 'active'
    | 'completed'
    | 'closed'
    | 'failed'
    | 'blocked'
    | 'cancelled'
    | 'timed-out'
  exitCode: number | null
  bytesSent: number | null
  bytesReceived: number | null
}

export interface NetworkActivitySnapshot {
  rows: NetworkActivityRow[]
  dropped: number
}
