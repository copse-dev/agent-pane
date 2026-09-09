import type { z } from 'zod'
import type { containerRuntimeAttestationSchema } from '../container-run-schema.ts'
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
export type ContainerRuntimeAttestation = z.infer<typeof containerRuntimeAttestationSchema>

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
