/**
 * Shared pack summary types for Settings → Packs and the `packs:*` IPCs
 * (P3 of docs/plans/hooks-and-feature-packs.md).
 *
 * The Settings pack list is the `about:addons` surface of Copse: one entry per
 * registered pack (first-party + user), with an enable/disable toggle, an
 * enumeration of what the pack contributes (tools / hooks / prompt / panels),
 * and any pack-scoped settings the manifest declares. Enable/disable is atomic
 * (P1 contract): the toggle drops every contribution kind from the active set
 * in one flag flip on the host `PackRegistry`.
 *
 * These types intentionally mirror the (Electron-free) `PackManifest` /
 * `PackContributions` shapes from `packages/agent/src/packs/`, but as
 * IPC-crossable summaries — no functions, no live registry references. The
 * renderer never sees a `RegisteredPack` directly; it renders these summaries.
 */

/** Trust tier assigned by the host; disk manifests cannot self-promote. */
export type PackTrustLevel = 'first-party' | 'user'

export interface PackDirectorySourceSummary {
  kind: 'directory'
  path: string
  contentHash: string
}
/** Product-support status declared by the manifest and shown in Settings. */
export type PackStabilityLevel = 'stable' | 'experimental'

/** UI contribution levels from the plan (1 = card, 2 = named panel, 3 = real view). */
export type PackUiLevel = 1 | 2 | 3

/**
 * Kind of value a pack-scoped setting field carries (rendered generically). Kept
 * in lockstep with `PackSettingKind` on the agent side. A `model` field is a
 * model-id string rendered as the grouped model picker; its option list is the
 * live model catalogue resolved by the renderer, never shipped in the manifest.
 */
export type PackSettingKind = 'boolean' | 'string' | 'number' | 'enum' | 'model'

/** One pack-scoped setting field, mirrors `PackSettingField` on the agent side. */
export interface PackSettingFieldSummary {
  /** Stable id of the setting, keyed under the pack's namespace. */
  id: string
  kind: PackSettingKind
  title: string
  description?: string
  /** Default value used when nothing is persisted for this pack + key (a model id for `kind: 'model'`). */
  default?: boolean | string | number
  /** Options for an `enum` field (`kind: 'enum'` only; a `model` field's options are resolved live). */
  options?: readonly string[]
  /** The current persisted value, or the default when nothing is stored yet. */
  value: boolean | string | number
}

/** One UI contribution enumerated in Settings so the user sees what a pack adds. */
export interface PackUiContributionSummary {
  id: string
  level: PackUiLevel
  /** Named host slot (level 2 / 3). Absent for level-1 declarative cards. */
  slot?: string
  /** Human title (Settings enumeration). */
  title?: string
  /** For level-2 declarative panels: `list` or `tree` (P2). */
  panelKind?: 'list' | 'tree'
}

/** One prompt / steering block a pack contributes (trust framing preserved). */
export interface PackPromptBlockSummary {
  id: string
  trust: 'trusted' | 'untrusted'
}

/**
 * One named runtime capability a pack owns — a pure behaviour flag (no tool /
 * hook / prompt / panel) that any subsystem reads through the registry's
 * `isCapabilityActive` seam. Enumerated in Settings so the user sees what the
 * toggle actually gates (e.g. the MCP-UI canvas, the DevTools shortcut).
 */
export interface PackCapabilitySummary {
  /** Stable capability id read via the registry accessor. */
  name: string
  /** Human title for the Settings enumeration. */
  title: string
  /** Optional human description. */
  description?: string
}

/**
 * One permission / sandbox relaxation a pack DECLARES it may request (issue
 * #1190) — the authority the pack opens. The permission-gate only grants a
 * declared relaxation while the owning pack is enabled; disabling the pack
 * revokes it atomically. Enumerated in Settings so the user sees what a pack can
 * request, and exposed for the future install-time capability/permission review
 * (#1082).
 */
export interface PackPermissionSummary {
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
 * Everything a pack contributes, enumerated for the Settings pack list. Both
 * first-party and user packs surface here (decision 15). Function hooks and
 * native tool wiring stay on the host side — the renderer only sees ids and
 * event names it can render.
 */
export interface PackContributionsSummary {
  /** Native tool names contributed to the model tool list (first-party). */
  toolNames: readonly string[]
  /** Thread models contributed by an enabled selected pack. */
  modelRoutes: readonly {
    id: string
    label: string
    group?: string
    description?: string
    supportsImages?: boolean
  }[]
  /** Exact origins this pack may operate in the visible interactive browser pane. */
  browserOrigins: readonly string[]
  /** MCP config path a user pack pulls its tools from (mirrors `plugin.json`). */
  mcpServersPath?: string
  /** Blocking (in-loop) function hooks the pack registers, by canonical event. */
  blockingHooks: readonly { id: string; event: string }[]
  /** Async (detached) function hooks the pack registers. */
  asyncHooks: readonly { id: string; event: string }[]
  /** Command-hook declarations from the manifest (user packs). */
  commandHooks: readonly { event: string; command: string }[]
  promptBlocks: readonly PackPromptBlockSummary[]
  ui: readonly PackUiContributionSummary[]
  /** Named runtime capability flags the pack owns (pure behaviour, no tool). */
  capabilities: readonly PackCapabilitySummary[]
  /** Permission / sandbox relaxations the pack may request while enabled (#1190). */
  permissions: readonly PackPermissionSummary[]
  /** Namespaced storage bag the pack owns (survives disable — decision 17). */
  storageNamespace?: string
}

/**
 * One pack row for the Settings list. `enabled` reflects the shared host
 * registry's current flag; toggling it in the UI calls `packs:setEnabled`,
 * which flips the flag atomically and persists to `electron-store`.
 */
export interface PackSummary {
  id: string
  trust: PackTrustLevel
  stability: PackStabilityLevel
  name: string
  version?: string
  description?: string
  enabled: boolean
  /** Present only for a pack explicitly selected from a directory. */
  source?: PackDirectorySourceSummary
  contributions: PackContributionsSummary
  /** Pack-scoped settings the manifest declares, each carrying its current value. */
  settings: readonly PackSettingFieldSummary[]
}

/** `packs:list` payload. */
export interface PacksListResult {
  packs: readonly PackSummary[]
}
