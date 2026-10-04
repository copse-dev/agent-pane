import type { AgentRoleId } from '@copse/llm/agent-roles.ts'

/** Stable field identities shared by recovery and Settings navigation. */
export type ModelSettingsTarget =
  | 'model'
  | 'localDefaultModel'
  | 'subagentModel'
  | 'smallTasksModel'
  | 'orchestrationWorkerModel'
  | 'safetyModel'
  | 'reviewModel'
  | 'advisorModel'
  | `role:${AgentRoleId}`
  | `plugin:${string}:${string}`

export interface ModelInvalidation {
  /** `thread` refers only to the concrete active selection supplied by the caller. */
  target: ModelSettingsTarget | 'thread'
  label: string
  model: string
  reason: string
  /** A discovered, role-capable on-device model. Missing means preserve the choice. */
  fallback?: string
}

export interface ModelSavedChoice {
  target: ModelSettingsTarget | 'thread'
  model: string
}
export interface ModelInvalidationReport {
  /** False when configuration changed during a probe; no scopes were evaluated. */
  evaluated: boolean
  invalidations: ModelInvalidation[]
  /** Effective saved choices and the active thread only when it was queried. */
  selections: ModelSavedChoice[]
  /** Positive provider/catalogue evidence, never an outage or unknown state. */
  verifiedChoices: ModelSavedChoice[]
}
