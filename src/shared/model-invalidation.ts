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
