/** A stable Copse-owned handle; never an arbitrary OS process id. */
export type ManagedProcessHandle =
  | { kind: 'terminal'; id: string }
  | { kind: 'background'; id: string; projectId: string; threadId: string }

/** One live app or Copse-managed child process. */
export interface ProcessManagerRow {
  pid: number
  startedAt: number
  label: string
  type: string
  threadId: string | null
  /** Owning project for navigation; null for shared or unscoped processes. */
  projectId?: string | null
  /** Present only when Copse can safely stop the owning task. */
  managed?: ManagedProcessHandle
  cpuPercent: number | null
  memoryMiB: number | null
}

export interface ProcessManagerSnapshot {
  sampledAt: number
  processes: ProcessManagerRow[]
}
