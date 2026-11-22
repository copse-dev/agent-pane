/**
 * Execution runtime contract (`docs/plans/execution-runtime-security.md`, R1).
 *
 * A runtime reports six security properties separately — filesystem, process
 * isolation, network, secrets, checkpoint and suspend/resume — so no single
 * "sandboxed" flag can stand in for all of them. A principal names who an
 * execution acts for; a grant names exactly what one principal may do, where,
 * and until when.
 *
 * Pure: no Node or Electron imports, so the contract, its validators and the
 * capability derivation are shared by the main process, headless hosts and the
 * thread-store readers.
 */
import { z } from 'zod'
import { memberOf } from '@copse/std/member-of.ts'

export const RUNTIME_FILESYSTEM = ['workspace', 'host', 'remote-account'] as const
export const RUNTIME_PROCESS_ISOLATION = [
  'none',
  'os-sandbox',
  'container',
  'vm',
  'provider-managed',
] as const
export const RUNTIME_NETWORK = [
  'none',
  'global-allowlist',
  'per-execution-broker',
  'unrestricted',
] as const
export const RUNTIME_SECRETS = ['raw-env', 'scoped-injection', 'brokered'] as const
export const RUNTIME_CHECKPOINT = ['none', 'workspace', 'full'] as const

const ExecutionRuntimeCapabilitiesSchema = z.object({
  filesystem: z.enum(RUNTIME_FILESYSTEM),
  processIsolation: z.enum(RUNTIME_PROCESS_ISOLATION),
  network: z.enum(RUNTIME_NETWORK),
  secrets: z.enum(RUNTIME_SECRETS),
  checkpoint: z.enum(RUNTIME_CHECKPOINT),
  suspendResume: z.boolean(),
  /**
   * Credential families a host-side broker attaches for this execution instead
   * of handing the workload a raw value (R2). `secrets` still describes every
   * other credential, so one brokered family never upgrades the whole runtime.
   */
  brokeredCredentials: z.array(z.string().min(1)).optional(),
})

export type ExecutionRuntimeCapabilities = z.infer<typeof ExecutionRuntimeCapabilitiesSchema>

/** Validate a capability snapshot read back from disk. */
export function parseExecutionRuntimeCapabilities(
  value: unknown,
): ExecutionRuntimeCapabilities | null {
  const parsed = ExecutionRuntimeCapabilitiesSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export const EXECUTION_PRINCIPAL_KINDS = ['human', 'automation', 'provider-managed'] as const

export type ExecutionPrincipalKind = (typeof EXECUTION_PRINCIPAL_KINDS)[number]

export const isExecutionPrincipalKind = memberOf(EXECUTION_PRINCIPAL_KINDS)

/** Who an execution acts for (binding decision 11). Never carries credential material. */
export interface ExecutionPrincipal {
  readonly id: string
  readonly kind: ExecutionPrincipalKind
  readonly projectId: string
  /** Automation principals: the schedule that owns the run. */
  readonly workflowId?: string
  /** Automation principals: the run (trigger time) the principal is bound to. */
  readonly taskId?: string
  readonly campaignId?: string
  readonly expiresAt?: number
}

/** The local desktop user. Interactive turns resolve to this principal. */
export const LOCAL_HUMAN_PRINCIPAL_ID = 'human:local'

export function humanPrincipal(projectId: string): ExecutionPrincipal {
  return { id: LOCAL_HUMAN_PRINCIPAL_ID, kind: 'human', projectId }
}

/**
 * An automation principal bound to one schedule run in one project. The id is
 * stable for that run and distinct from every other run of the same schedule,
 * so a grant recorded for one run cannot be read as belonging to the next.
 */
export function automationPrincipal(
  projectId: string,
  scheduleId: string,
  triggeredAt: number,
): ExecutionPrincipal {
  return {
    id: `automation:${scheduleId}@${String(triggeredAt)}`,
    kind: 'automation',
    projectId,
    workflowId: scheduleId,
    taskId: String(triggeredAt),
  }
}

/** One approved capability, bound to exactly one principal (binding decision 3). */
export interface ExecutionGrant {
  readonly principalId: string
  readonly projectId: string
  readonly threadId: string
  readonly turnId: string
  readonly operation: string
  readonly filesystem?: { readonly read?: readonly string[]; readonly write?: readonly string[] }
  readonly network?: {
    readonly origins: readonly string[]
    readonly methods?: readonly string[]
    readonly ports?: readonly number[]
  }
  /** Opaque credential identity; never the credential's value. */
  readonly credentialRef?: string
  readonly expiresAt: number
  readonly remembered: boolean
}

/**
 * How one execution was contained, as the spawn layer decided it. `contained`
 * means the local OS sandbox wrapped the process; `host` means it ran with the
 * user's own access (an approved escape, or no sandbox on this platform).
 */
export type LocalContainment = 'contained' | 'host'

export type RuntimeProfile =
  | { readonly kind: 'local'; readonly containment: LocalContainment }
  | { readonly kind: 'ssh'; readonly hostId: string }

/**
 * Stable identity of a runtime profile, recorded on every audit line. Local
 * profiles differ by containment because their properties differ; an SSH
 * profile is named by its configured host.
 */
export function runtimeProfileId(profile: RuntimeProfile): string {
  return profile.kind === 'local' ? `local/${profile.containment}` : `ssh:${profile.hostId}`
}

/**
 * The properties a runtime profile actually has today. Deliberately
 * conservative: SSH reports no isolation whatever this machine's sandbox does,
 * because Copse applies none on the remote host; the local sandbox reports a
 * global allowlist because ASRT's network scope is process-wide.
 */
export function deriveRuntimeCapabilities(
  profile: RuntimeProfile,
  options: { readonly brokeredCredentials?: readonly string[] } = {},
): ExecutionRuntimeCapabilities {
  const brokered =
    options.brokeredCredentials && options.brokeredCredentials.length > 0
      ? { brokeredCredentials: [...options.brokeredCredentials].sort() }
      : {}
  if (profile.kind === 'ssh') {
    return {
      filesystem: 'remote-account',
      processIsolation: 'none',
      network: 'unrestricted',
      secrets: 'raw-env',
      checkpoint: 'none',
      suspendResume: false,
      ...brokered,
    }
  }
  if (profile.containment === 'contained') {
    return {
      filesystem: 'workspace',
      processIsolation: 'os-sandbox',
      network: 'global-allowlist',
      secrets: 'raw-env',
      checkpoint: 'none',
      suspendResume: false,
      ...brokered,
    }
  }
  return {
    filesystem: 'host',
    processIsolation: 'none',
    network: 'unrestricted',
    secrets: 'raw-env',
    checkpoint: 'none',
    suspendResume: false,
    ...brokered,
  }
}
