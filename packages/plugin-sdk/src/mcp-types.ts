export type McpTransportKind = 'stdio' | 'http' | 'in-process'

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

/**
 * Where a server's definition came from.
 *
 * Settings → MCP servers is the one place that answers "what is this app
 * allowed to talk to, and who asked for it". `source` alone cannot: it is a
 * bare path, and telling `~/.cursor/mcp.json` (the user's own) apart from a
 * plugin's bundled `mcp.json` means knowing where each root lives — knowledge
 * the main process has and the renderer does not. So the origin is classified
 * where it is knowable and shipped alongside the path.
 */
export type McpServerOrigin =
  /** The user's own global config, or Copse's own userData `mcp.json`. */
  | 'user'
  /** A `.mcp.json` / `.cursor/mcp.json` in the open workspace — repo-supplied. */
  | 'project'
  /** Declared by an installed plugin's MCP config. */
  | 'plugin'
  /** The built-in "Copse reviewed" catalog. */
  | 'curated'
  /** Shipped inside the app itself (the in-process bundled servers). */
  | 'built-in'

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
  /** Which kind of config asked for this server. See {@link McpServerOrigin}. */
  origin: McpServerOrigin
  /** Human label for the origin — a plugin's name, a config filename. */
  originDetail?: string
  error?: string
  /** User has not turned this server off in Settings (app-local override). */
  userEnabled: boolean
  /** `"disabled": true` in the on-disk MCP config; cannot be enabled from the UI. */
  configDisabled: boolean
  /** Defined by the built-in "Copse reviewed" catalog rather than an mcp.json file. */
  curated?: boolean
}

/**
 * An MCP server a plugin's `mcp.json` declares that the app is **not** running.
 *
 * An installed plugin can name servers Copse never spawns — because the plugin
 * is turned off, or because its declarations are validated but not yet wired
 * into the agent loop. Left out of Settings entirely, those declarations are
 * invisible: the list would say "no servers" while a package on disk names
 * three. Since the point of this section is to be the complete account of the
 * app's outbound connections, a declaration that is not running is still
 * something to show — as a distinct, inert row, never mixed in with the live
 * ones.
 */
export interface DeclaredMcpServer {
  name: string
  transport: McpTransportKind
  /** Registry id of the plugin that declares it — also what Settings shows. */
  pluginId: string
  /** Whether the declaring plugin is currently enabled. */
  pluginEnabled: boolean
  /** Why it is not running, in one phrase. */
  reason: string
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
