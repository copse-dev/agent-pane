/**
 * Unattended runs on a contained runtime (`docs/plans/thread-in-container.md`).
 *
 * Shared between the main process, the container worker entry and the review
 * surfaces, so every consumer describes the runtime with one vocabulary.
 */

/**
 * What actually confines the process a thread's commands run in. A property of
 * the resolved runtime, never of a setting: `container` is only ever declared by
 * a worker that was started inside a Copse-provisioned container and handed an
 * attestation of the hardening it runs under.
 */
export type RuntimeContainmentTier = 'container' | 'project-sandbox' | 'unsandboxed'

/**
 * How the container was started, as recorded by the host that started it. The
 * worker reads this rather than probing, because a guest cannot verify its own
 * boundary from the inside; the record is what the review surface shows.
 */
export interface ContainerRuntimeAttestation {
  runtimeId: string
  /** Image reference and, when known, its resolved digest. */
  image: string
  imageDigest?: string
  /** Uid the worker runs as; never 0. */
  user: number
  readOnlyRootfs: boolean
  capDropAll: boolean
  noNewPrivileges: boolean
  pidsLimit: number
  memoryLimit: string
  /** `none` is no interface at all; `brokered` is loopback listeners to named origins only. */
  network: 'none' | 'brokered'
  /** Origins (`host:port`) reachable through the broker; empty when `network` is `none`. */
  egressAllowlist: string[]
  /** No host path is mounted except the run directory the host owns. */
  hostMounts: string[]
}

export interface UnattendedRunBudgets {
  /** Wall-clock ceiling for the whole run. */
  wallClockMs: number
  /** Total input + output tokens before the run suspends. */
  tokenCeiling: number
}

export type UnattendedRunPhase = 'off' | 'armed' | 'active'

export interface UnattendedRunState {
  threadId: string
  phase: UnattendedRunPhase
  runtimeId: string | null
  containment: RuntimeContainmentTier
  budgets: UnattendedRunBudgets | null
}
