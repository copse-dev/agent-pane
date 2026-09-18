import type { McpServerOrigin, McpServerState } from './mcp.ts'

export const TOOL_PERMISSION_POLICIES = ['allow', 'ask', 'block'] as const

export type ToolPermissionPolicy = (typeof TOOL_PERMISSION_POLICIES)[number]

export interface ToolPermissionCatalogTool {
  /** Stable persisted identity. This is not the provider-facing execution name. */
  id: string
  /** Name used by the agent/tool registry when invoking the tool. */
  executionName: string
  /** Short human-readable label. */
  name: string
  description: string
  /** Displayed selection: the override when present, otherwise the inherited default. */
  policy: ToolPermissionPolicy
  defaultPolicy: ToolPermissionPolicy
  /** False means the existing permission system still decides each invocation. */
  overridden: boolean
  disabledPolicies?: ToolPermissionPolicy[]
  disabledReason?: string
}

export interface ToolPermissionCatalogGroup {
  id: string
  name: string
  kind: 'copse' | 'mcp'
  origin?: McpServerOrigin
  originDetail?: string
  status?: McpServerState
  tools: ToolPermissionCatalogTool[]
}

export interface ToolPermissionCatalog {
  groups: ToolPermissionCatalogGroup[]
}

export interface ToolPermissionUpdate {
  toolIds: string[]
  policy: ToolPermissionPolicy
}

export interface ToolPermissionReset {
  toolIds: string[]
}
