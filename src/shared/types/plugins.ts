/**
 * Shared plugin summary types for Settings → Plugins and the `plugins:*` IPCs
 * (P3 of docs/plans/hooks-and-feature-packs.md).
 *
 * The Settings plugin list is the `about:addons` surface of Copse: one entry per
 * registered plugin (first-party + user), with an enable/disable toggle, an
 * enumeration of what the plugin contributes (tools / hooks / prompt / panels),
 * and any plugin-scoped settings the manifest declares. Enable/disable is atomic
 * (P1 contract): the toggle drops every contribution kind from the active set
 * in one flag flip on the host `PluginRegistry`.
 *
 * These types intentionally mirror the (Electron-free) `PluginManifest` /
 * `PluginContributions` shapes from `packages/agent/src/plugins/`, but as
 * IPC-crossable summaries — no functions, no live registry references. The
 * renderer never sees a `RegisteredPlugin` directly; it renders these summaries.
 */

/** Trust tier assigned by the host; disk manifests cannot self-promote. */
export type PluginTrustLevel = 'first-party' | 'user'

export interface PluginDirectorySourceSummary {
  kind: 'directory'
  path: string
  contentHash: string
}
/** Product-support status declared by the manifest and shown in Settings. */
export type PluginStabilityLevel = 'stable' | 'experimental'

/** UI contribution levels from the plan (1 = card, 2 = named panel, 3 = real view). */
export type PluginUiLevel = 1 | 2 | 3

/**
 * Kind of value a plugin-scoped setting field carries (rendered generically). Kept
 * in lockstep with `PluginSettingKind` on the agent side. A `model` field is a
 * model-id string rendered as the grouped model picker; its option list is the
 * live model catalogue resolved by the renderer, never shipped in the manifest.
 */
export type PluginSettingKind = 'boolean' | 'string' | 'number' | 'enum' | 'model'

/** One plugin-scoped setting field, mirrors `PluginSettingField` on the agent side. */
export interface PluginSettingFieldSummary {
  /** Stable id of the setting, keyed under the plugin's namespace. */
  id: string
  kind: PluginSettingKind
  title: string
  description?: string
  /** Default value used when nothing is persisted for this plugin + key (a model id for `kind: 'model'`). */
  default?: boolean | string | number
  /** Options for an `enum` field (`kind: 'enum'` only; a `model` field's options are resolved live). */
  options?: readonly string[]
  /** The current persisted value, or the default when nothing is stored yet. */
  value: boolean | string | number
}

/** One UI contribution enumerated in Settings so the user sees what a plugin adds. */
export interface PluginUiContributionSummary {
  id: string
  level: PluginUiLevel
  /** Named host slot (level 2 / 3). Absent for level-1 declarative cards. */
  slot?: string
  /** Human title (Settings enumeration). */
  title?: string
  /** For level-2 declarative panels: `list` or `tree` (P2). */
  panelKind?: 'list' | 'tree'
}

/** One prompt / steering block a plugin contributes (trust framing preserved). */
export interface PluginPromptBlockSummary {
  id: string
  trust: 'trusted' | 'untrusted'
}

/**
 * One named runtime capability a plugin owns — a pure behaviour flag (no tool /
 * hook / prompt / panel) that any subsystem reads through the registry's
 * `isCapabilityActive` seam. Enumerated in Settings so the user sees what the
 * toggle actually gates (e.g. the MCP-UI canvas, the DevTools shortcut).
 */
export interface PluginCapabilitySummary {
  /** Stable capability id read via the registry accessor. */
  name: string
  /** Human title for the Settings enumeration. */
  title: string
  /** Optional human description. */
  description?: string
}

/**
 * One permission / sandbox relaxation a plugin DECLARES it may request (issue
 * #1190) — the authority the plugin opens. The permission-gate only grants a
 * declared relaxation while the owning plugin is enabled; disabling the plugin
 * revokes it atomically. Enumerated in Settings so the user sees what a plugin can
 * request, and exposed for the future install-time capability/permission review
 * (#1082).
 */
export interface PluginPermissionSummary {
  /** Stable relaxation id resolved by the permission-gate. */
  name: string
  /** Human title for the Settings enumeration. */
  title: string
  /** Optional human description of the authority the relaxation opens. */
  description?: string
  /** The granularity of the permission grant that gates the relaxation. */
  scope?: 'project' | 'workspace'
}

/**
 * Everything a plugin contributes, enumerated for the Settings plugin list. Both
 * first-party and user plugins surface here (decision 15). Function hooks and
 * native tool wiring stay on the host side — the renderer only sees ids and
 * event names it can render.
 */
export interface PluginContributionsSummary {
  /** Native tool names contributed to the model tool list (first-party). */
  toolNames: readonly string[]
  /** Thread models contributed by an enabled selected plugin. */
  modelRoutes: readonly {
    id: string
    label: string
    group?: string
    description?: string
    supportsImages?: boolean
  }[]
  /** Exact origins this plugin may operate in the visible interactive browser pane. */
  browserOrigins: readonly string[]
  /** MCP config path a user plugin pulls its tools from (mirrors `plugin.json`). */
  mcpServersPath?: string
  /** Blocking (in-loop) function hooks the plugin registers, by canonical event. */
  blockingHooks: readonly { id: string; event: string }[]
  /** Async (detached) function hooks the plugin registers. */
  asyncHooks: readonly { id: string; event: string }[]
  /** Command-hook declarations from the manifest (user plugins). */
  commandHooks: readonly { event: string; command: string }[]
  promptBlocks: readonly PluginPromptBlockSummary[]
  ui: readonly PluginUiContributionSummary[]
  /** Named runtime capability flags the plugin owns (pure behaviour, no tool). */
  capabilities: readonly PluginCapabilitySummary[]
  /** Permission / sandbox relaxations the plugin may request while enabled (#1190). */
  permissions: readonly PluginPermissionSummary[]
  /** Namespaced storage bag the plugin owns (survives disable — decision 17). */
  storageNamespace?: string
}

/**
 * One plugin row for the Settings list. `enabled` reflects the shared host
 * registry's current flag; toggling it in the UI calls `plugins:setEnabled`,
 * which flips the flag atomically and persists to `electron-store`.
 */
export interface PluginSummary {
  id: string
  trust: PluginTrustLevel
  stability: PluginStabilityLevel
  name: string
  version?: string
  description?: string
  enabled: boolean
  /** Present only for a plugin explicitly selected from a directory. */
  source?: PluginDirectorySourceSummary
  contributions: PluginContributionsSummary
  /** Plugin-scoped settings the manifest declares, each carrying its current value. */
  settings: readonly PluginSettingFieldSummary[]
}

/** `plugins:list` payload. */
export interface PluginsListResult {
  plugins: readonly PluginSummary[]
}
