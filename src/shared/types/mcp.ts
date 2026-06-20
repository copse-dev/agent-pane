export type McpTransportKind = 'stdio' | 'http'

/** Server-reported hints about a tool. All fields are advisory only. */
export interface McpToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/** A normalized MCP server definition, independent of the on-disk config shape. */
export interface McpServerConfig {
  name: string
  transport: McpTransportKind
  /** Source file the definition came from (for diagnostics). */
  source?: string
  /** Whether the user has disabled this server. */
  disabled?: boolean
  /** When true, tools from this server auto-run without per-call approval. */
  trusted?: boolean

  // stdio
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string

  // http
  url?: string
  headers?: Record<string, string>
}

export type McpServerState = 'connected' | 'error' | 'disabled' | 'connecting'

export interface McpServerStatus {
  name: string
  transport: McpTransportKind
  state: McpServerState
  toolCount: number
  /** Human tool names (without the mcp__server__ prefix). */
  tools: string[]
  trusted: boolean
  source?: string
  error?: string
  /** User has not turned this server off in Settings (app-local override). */
  userEnabled: boolean
  /** `"disabled": true` in the on-disk MCP config; cannot be enabled from the UI. */
  configDisabled: boolean
}
