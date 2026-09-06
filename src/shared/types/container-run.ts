/**
 * Unattended container runs as the renderer sees them
 * (`docs/plans/thread-in-container.md`). Everything here is plain JSON: the
 * main process owns the run and pushes these snapshots over IPC.
 */
import type { ContainerRuntimeAttestation, UnattendedRunBudgets } from './unattended-run.ts'

export interface EgressLogEntry {
  at: number
  origin: string
  /** `refused`: the guest asked for a target the allowlist does not admit. */
  event: 'connect' | 'close' | 'error' | 'refused'
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
  /**
   * Who ran the loop: Copse's own harness, or an external ACP agent by id
   * (`docs/plans/thread-in-container.md`, decision A3). The record has to say
   * so, because the deferral guarantee below is a property of Copse's harness:
   * under an agent, outward effects are denied rather than queued for replay.
   */
  harness: 'copse' | { acp: string }
  /** Approval prompts the worker's fail-closed handler saw. Must be zero. */
  promptsAttempted: number
  deferrals: Array<{ id: string; title: string; subject: string; reasons?: string[] }>
  /**
   * Effects the contained policy refused outright: host escapes always, and
   * under an ACP harness the outward effects Copse could not replay. Read back
   * from the run's own decision log, so nothing refused goes unreported.
   */
  denials: Array<{ subject: string; reasons: string[] }>
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
  /**
   * Retrieval of the guest's commits. `expected` is true when the guest wrote a
   * bundle, so `ref === null` with `expected` means the work exists but could
   * not be fetched — never report that as a clean finish.
   */
  carryOut: { expected: boolean; ref: string | null; error: string | null }
  containerExit: number | null
  teardown: 'removed' | 'already-gone' | 'failed'
  /** Non-null when stopping or reaping the container did not settle cleanly. */
  cleanupError: string | null
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
  /**
   * The task the run was started with. Part of what the run *is*, so the review
   * record can say what was asked and a re-run can offer it again — the dialog
   * no longer composes the task, so it has nowhere else to read it from.
   */
  prompt: string
  /** The model the guest was given and the origins it may reach. */
  model: string
  egressAllowlist: string[]
  /** Most recent host and guest log lines (bounded). */
  log: string[]
  /**
   * Things that went wrong around the work itself — a container that would not
   * reap, commits that could not be fetched. Surfaced even on a run whose agent
   * finished, so cleanup failures are never silent.
   */
  warnings: string[]
  /**
   * The checkout carried into the container: a thread with an isolated worktree
   * runs its own branch and edits, not the project's.
   */
  checkout: { root: string; mode: 'shared' | 'worktree'; branch: string | null } | null
  record: ThreadContainerRecord | null
  error: string | null
}
