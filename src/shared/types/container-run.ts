import type { z } from 'zod'
import type {
  threadContainerResultSchema,
  containerRunRequestSchema,
} from '../container-run-schema.ts'
/**
 * Unattended container runs as the renderer sees them
 * (`docs/plans/thread-in-container.md`). Everything here is plain JSON: the
 * main process owns the run and pushes these snapshots over IPC.
 */
import type { ContainerRuntimeAttestation } from './unattended-run.ts'
import type { SubagentMessage } from '@copse/agent/wire-types.ts'

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
// A named mapped type retains the existing API schema reference while deriving every field.
export type ThreadContainerResult = {
  [Key in keyof z.infer<typeof threadContainerResultSchema>]: z.infer<
    typeof threadContainerResultSchema
  >[Key]
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
   * The guest's own transcript, folded from the stream the harness produced
   * (assistant text, reasoning, tool calls with their results, bounded) so the
   * thread that launched the run can show it as the run's timeline (A13).
   * Empty when the guest wrote none.
   */
  transcript: SubagentMessage[]
  /**
   * The commit the guest started from: HEAD, or a snapshot commit on top of it
   * when the working tree was dirty. The guest's commits are the ones after
   * it on `carryOut.ref`, which is what a follow-up applies to the checkout.
   */
  carryIn: { sha: string; dirty: boolean }
  /**
   * Retrieval of the guest's commits. `expected` is true when the guest wrote a
   * bundle, so `ref === null` with `expected` means the work exists but could
   * not be fetched — never report that as a clean finish.
   */
  carryOut: { expected: boolean; ref: string | null; error: string | null }
  containerExit: number | null
  /**
   * What the guest held: a run-scoped key, the user's sign-in (the home
   * directories that were copied in, discarded with the container), or nothing.
   */
  credential: 'none' | 'key' | { login: string[] }
  teardown: 'removed' | 'already-gone' | 'failed'
  /** Non-null when stopping or reaping the container did not settle cleanly. */
  cleanupError: string | null
  secretCanary: { present: boolean; detail: string }
}

export type ContainerRunPhase =
  | 'preparing'
  | 'building-image'
  | 'starting'
  | 'installing'
  | 'running'
  | 'collecting'
  | 'finished'
  | 'failed'

/** What the renderer asks for. Everything else the main process resolves itself. */
export type ContainerRunRequest = {
  [Key in keyof z.infer<typeof containerRunRequestSchema>]: z.infer<
    typeof containerRunRequestSchema
  >[Key]
}

/**
 * The resolver's verdict on one picker row (`container:model-availability`).
 * `reason` is null when the row runs as it is. `loginOffered` names an agent
 * that has no key but would run on the user's sign-in if they opt in: the row
 * is offered, and choosing it reveals the opt-in.
 */
export interface ContainerModelVerdict {
  reason: string | null
  loginOffered?: { agentTitle: string }
}

/** What the guest was given to authenticate with. */
export type ContainerRunCredential = 'none' | 'key' | 'login'

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
  /** A vendor key scoped to the run, the user's sign-in copied in, or nothing. */
  credential: ContainerRunCredential
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
  /** The earlier run this one continues from (its runtime id), or null for a fresh run. */
  continuedFrom: string | null
}
