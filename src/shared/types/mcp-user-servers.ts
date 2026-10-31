/**
 * Servers in Copse's own `mcp.json` (under userData), the one MCP config file
 * Settings edits. Other config files (`~/.cursor/mcp.json`, a project's
 * `.mcp.json`) stay hand-edited: Copse reads them but never rewrites them.
 *
 * Env and header values are secrets. They cross IPC towards the main process
 * only: the renderer is told which keys exist, never their values, and a save
 * that leaves a value out keeps the stored one.
 */

/** A stored env var or header, by name. Its value stays in the main process. */
export interface McpStoredSecretKey {
  key: string
}

export type McpUserServer =
  | {
      transport: 'stdio'
      name: string
      command: string
      args: string[]
      cwd?: string
      env: McpStoredSecretKey[]
    }
  | {
      transport: 'http'
      name: string
      url: string
      headers: McpStoredSecretKey[]
    }

export interface McpUserServerList {
  /** Absolute path of the file; statuses whose `source` matches came from it. */
  path: string
  servers: McpUserServer[]
  /** Set when the file exists but cannot be edited safely (invalid JSON, legacy shape). */
  error?: string
}

/** An env var or header to save. Omit `value` to keep the one already stored under `key`. */
export interface McpSecretEntryInput {
  key: string
  value?: string | undefined
}

export type McpUserServerInput =
  | {
      transport: 'stdio'
      name: string
      command: string
      args: string[]
      cwd?: string | undefined
      env: McpSecretEntryInput[]
    }
  | {
      transport: 'http'
      name: string
      url: string
      headers: McpSecretEntryInput[]
    }

/** Form fields a rejected save can point at. */
export type McpUserServerField = 'name' | 'command' | 'cwd' | 'url' | 'env' | 'headers' | 'form'

export type McpUserServerSaveResult =
  | { ok: true; list: McpUserServerList }
  | { ok: false; field: McpUserServerField; message: string }
