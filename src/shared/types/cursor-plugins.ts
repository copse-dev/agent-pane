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

/** A Cursor plugin whose skills ship inside Copse (`vendor/bundled-cursor-skills`). */
export interface BundledSkillPluginSummary {
  /** Plugin id from `.cursor-plugin/plugin.json` `name`. */
  name: string
  description?: string
  version?: string
  skillCount: number
  /** This plugin's own switch: the user's choice, else {@link defaultEnabled}. */
  enabled: boolean
  defaultEnabled: boolean
  /** Why the plugin ships switched off, when it does. */
  offByDefaultReason?: string
  /**
   * Every bundled skill is off (Settings → Agent → Skills), so this plugin
   * contributes nothing whatever its own switch says.
   */
  suppressed: boolean
}
