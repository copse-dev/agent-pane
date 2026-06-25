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

  // stdio
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string

  // http
  url?: string
  headers?: Record<string, string>
}

export type McpServerState =
  | 'connected'
  | 'error'
  | 'disabled'
  | 'connecting'
  /** Project-defined server in a workspace the user has not trusted; not spawned. */
  | 'untrusted'

export interface McpServerStatus {
  name: string
  transport: McpTransportKind
  state: McpServerState
  toolCount: number
  /** Human tool names (without the mcp__server__ prefix). */
  tools: string[]
  source?: string
  error?: string
  /** User has not turned this server off in Settings (app-local override). */
  userEnabled: boolean
  /** `"disabled": true` in the on-disk MCP config; cannot be enabled from the UI. */
  configDisabled: boolean
  /** Defined by the built-in "Copse reviewed" catalog rather than an mcp.json file. */
  curated?: boolean
}

/**
 * A vetted MCP server shipped with the app ("Copse reviewed"). These are not
 * read from any config file; they are off by default and the user opts in with
 * a toggle. The connection fields mirror {@link McpServerConfig}.
 */
export interface CuratedMcpServer {
  /** Stable id, also used as the server name and `mcp__<name>__` tool prefix. */
  name: string
  /** Human-friendly title shown in Settings. */
  title: string
  /** One-line description of what the server provides. */
  description: string
  /** Homepage / documentation URL (opened externally). */
  homepage: string
  transport: McpTransportKind

  // stdio
  command?: string
  args?: string[]

  // http
  url?: string
  headers?: Record<string, string>
}

/** A curated catalog entry joined with its enabled flag and live connection state. */
export interface CuratedMcpServerStatus extends CuratedMcpServer {
  /** Whether the user has turned this server on (off by default). */
  enabled: boolean
  /** Live connection state when enabled; `'disabled'` when off. */
  state: McpServerState
  toolCount: number
  tools: string[]
  error?: string
}
