/**
 * Unattended container runs as the renderer sees them
 * (`docs/plans/thread-in-container.md`). Everything here is plain JSON: the
 * main process owns the run and pushes these snapshots over IPC.
 */
import type { ContainerRuntimeAttestation, UnattendedRunBudgets } from './unattended-run.ts'

export interface EgressLogEntry {
  at: number
  origin: string
  event: 'connect' | 'close' | 'error'
  bytesToOrigin?: number
  bytesFromOrigin?: number
  detail?: string
}

/** What the guest writes to `out/result.json`. */
export interface ThreadContainerResult {
  threadId: string
  stopReason: 'completed' | 'budget:wall-clock' | 'budget:tokens' | 'aborted' | 'error'
  error?: string
  usage: { inputTokens: number; outputTokens: number }
  /** Approval prompts the worker's fail-closed handler saw. Must be zero. */
  promptsAttempted: number
  deferrals: Array<{ id: string; title: string; subject: string; reasons?: string[] }>
  commits: string[]
  containment: {
    declared: boolean
    declineReason: string | null
    projectSandbox: boolean
  }
  toolNames: string[]
  finalText: string
}

/** The host-written review record (`unattended-runs.md` Decision 8). */
export interface ThreadContainerRecord {
  runtimeId: string
  threadId: string
  startedAt: number
  finishedAt: number
  image: string
  imageDigest: string | null
  attestation: ContainerRuntimeAttestation
  egress: EgressLogEntry[]
  result: ThreadContainerResult | null
  carryOutRef: string | null
  containerExit: number | null
  teardown: 'removed' | 'already-gone' | 'failed'
  secretCanary: { present: boolean; detail: string }
}

export type ContainerRunPhase =
  | 'preparing'
  | 'building-image'
  | 'starting'
  | 'running'
  | 'collecting'
  | 'finished'
  | 'failed'

/** What the renderer asks for. Everything else the main process resolves itself. */
export interface ContainerRunRequest {
  projectId: string
  threadId: string
  prompt: string
  /** Product model id the thread runs on; the main process resolves its provider. */
  model: string
  budgets: UnattendedRunBudgets
  /** Extra `host:port` origins the broker may forward to, beyond the model's. */
  extraEgress?: string[]
}

/** Live snapshot of one thread's container run, pushed on every change. */
export interface ContainerRunProgress {
  threadId: string
  runtimeId: string | null
  phase: ContainerRunPhase
  startedAt: number
  finishedAt: number | null
  /** The model the guest was given and the origins it may reach. */
  model: string
  egressAllowlist: string[]
  /** Most recent host and guest log lines (bounded). */
  log: string[]
  record: ThreadContainerRecord | null
  error: string | null
}
