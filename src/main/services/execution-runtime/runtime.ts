/**
 * The `ExecutionRuntime` adapter contract (`docs/plans/execution-runtime-security.md`,
 * binding decision 2 and phase R1).
 *
 * `ExecutionTarget` still routes; a runtime owns execution and reports what it
 * actually enforces. Two adapters exist today: local (the project OS sandbox or
 * the user's own access) and SSH (a transport to a remote account, never a
 * claim of remote containment). Create, inspect, checkpoint and suspend/resume
 * belong to later phases (R4, R5) and are deliberately absent until a backend
 * can implement them honestly.
 */
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import type {
  ExecutionRuntimeCapabilities,
  RuntimeProfile,
} from '@shared/threads/execution-runtime.ts'

export type RuntimeCommand =
  | { readonly kind: 'argv'; readonly executable: string; readonly args: readonly string[] }
  | { readonly kind: 'shell'; readonly commandLine: string }

/** What the local sandbox wrap needs; built lazily because only contained runs use it. */
export interface LocalSandboxPlan {
  readonly config: Partial<SandboxRuntimeConfig>
  /**
   * Run this contained command in a dedicated host process instead of wrapping
   * it here (an approved loopback-binding background task, whose ASRT network
   * scope must never be shared with other contained commands in this process).
   * The host owns the wrap, its lease and its network scope; the adapter
   * ignores this plan's lease fields and never releases a lease for it.
   */
  readonly hostedLaunch?: () => ChildProcess
  /** Working directory ASRT resolves the wrap's relative paths against. */
  readonly wrapCwd?: string
  /** Host-owned attempt id ASRT attributes this command's sandbox violations to. */
  readonly violationId?: string
  /**
   * This process owns its ASRT lease for its whole lifetime (a background task),
   * so the adapter releases the lease when it closes. Foreground callers release
   * their own lease once they have read the violation log.
   */
  readonly ownsSandboxLease?: boolean
}

/**
 * How the caller asked a local execution to be contained. The adapter decides
 * the final containment after checking the working directory, so a sandbox
 * that disappears mid-request is observed at the same point as before.
 */
export interface LocalContainmentRequest {
  /** False for an approved escape; true asks for the project sandbox when it is active. */
  readonly sandbox: boolean
  /** Refuse with this message rather than run outside the sandbox. */
  readonly requireSandbox?: string
  /**
   * Credentials this contained run was deliberately given, such as a scoped
   * network plan's `GH_TOKEN`. Every other tool or cloud credential is removed
   * from a contained command's env (`envForContainedChildProcess`).
   */
  readonly keepCredentialEnv?: readonly string[]
  readonly plan: () => LocalSandboxPlan
}

export interface RuntimeExecRequest {
  readonly command: RuntimeCommand
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
  readonly signal?: AbortSignal
  readonly stdio?: SpawnOptions['stdio']
  /**
   * Re-check `signal` at each local await (after the working-directory check and
   * the sandbox wrap) and throw instead of spawning a child that is already
   * cancelled.
   */
  readonly abortCheckpoints?: boolean
  /** Read by the local adapter only. SSH execution has no Copse containment to request. */
  readonly local?: LocalContainmentRequest
}

/** A started execution: the child plus the profile and properties it actually ran under. */
export interface RuntimeExecution {
  readonly child: ChildProcess
  readonly profile: RuntimeProfile
  readonly capabilities: ExecutionRuntimeCapabilities
}

export interface ExecutionRuntime {
  readonly kind: RuntimeProfile['kind']
  /** Properties an execution of this request would have, without starting it. */
  capabilities: (request: RuntimeExecRequest) => ExecutionRuntimeCapabilities
  exec: (request: RuntimeExecRequest) => Promise<RuntimeExecution>
  /**
   * Release runtime-owned resources. Idempotent: the local runtime owns none,
   * and the SSH runtime's connections belong to the shared SSH transport, so
   * both converge to the same state however often this is called.
   */
  stop: () => Promise<void>
}
