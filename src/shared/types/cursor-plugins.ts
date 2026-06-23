/** Summary of a Cursor plugin discovered on disk (skills + optional MCP). */
export interface CursorPluginSummary {
  /** Plugin id from `.cursor-plugin/plugin.json` `name`, or the directory basename. */
  name: string
  /** Absolute path to the plugin root (directory containing `.cursor-plugin/`). */
  root: string
  description?: string
  version?: string
  /** Resolved skills directory, when present. */
  skillsDir?: string
  /** Resolved MCP config file path, when `mcpServers` is set in the manifest. */
  mcpConfigPath?: string
}
