// Plugin-summary projection — P3 of the feature-plugin layer.
//
// The Settings plugin list ("about:addons of Copse") enumerates every registered
// plugin's contributions so users can see what a plugin adds before toggling it.
// The renderer never receives a live `RegisteredPlugin` (the executable
// contributions cross a process boundary); instead the host walks the shared
// `PluginRegistry` and hands the renderer a plain-data snapshot of what each plugin
// contributes and what its current plugin-scoped settings values are. This module
// is that projection.
//
// Pure and Electron-free (execution-guidance rule 4): the projection only reads
// from the `RegisteredPlugin` shape and returns a serialisable summary. The host
// module `src/main/services/plugins/plugin-service.ts` is what wires it to
// electron-store persistence and IPC.
import type { PluginRegistry } from './plugin-registry.ts'
import type {
  PluginFollowUpDecl,
  PluginManifest,
  PluginSettingField,
  PluginUiContribution,
  RegisteredPlugin,
} from './plugin-manifest.ts'

/** Field kinds a plugin-scoped setting can declare (kept in lockstep with `PluginSettingKind`). */
type PluginSettingKindOut = PluginSettingField['kind']

/** One plugin-scoped setting field rendered generically by Settings (P3). */
export interface PluginSettingFieldOut {
  id: string
  kind: PluginSettingKindOut
  title: string
  description?: string
  default?: boolean | string | number
  options?: readonly string[]
  /** Current persisted value, or the field's declared default. */
  value: boolean | string | number
}

/** One UI contribution enumerated for the Settings plugin list. */
export interface PluginUiContributionOut {
  id: string
  level: PluginUiContribution['level']
  slot?: string
  title?: string
  panelKind?: 'list' | 'tree'
}

/** One prompt / steering block enumerated with its trust framing. */
export interface PluginPromptBlockOut {
  id: string
  trust: 'trusted' | 'untrusted'
}

/** One follow-up bubble enumerated for the Settings plugin list. */
export interface PluginFollowUpOut {
  id: string
  label: string
  /** Resolved rather than optional — Settings shows what the click will do. */
  action: NonNullable<PluginFollowUpDecl['action']>
  when: NonNullable<PluginFollowUpDecl['when']>
}

/** One runtime capability flag enumerated for the Settings plugin list. */
export interface PluginCapabilityOut {
  name: string
  title: string
  description?: string
}

/** One permission / sandbox relaxation enumerated for the Settings plugin list. */
export interface PluginPermissionOut {
  name: string
  title: string
  description?: string
  scope?: 'project' | 'workspace'
}

/** Contributions snapshot for one plugin (renderer-facing plain data). */
export interface PluginContributionsOut {
  toolNames: readonly string[]
  modelRoutes: readonly {
    id: string
    label: string
    group?: string
    description?: string
    supportsImages?: boolean
  }[]
  browserOrigins: readonly string[]
  mcpServersPath?: string
  blockingHooks: readonly { id: string; event: string }[]
  asyncHooks: readonly { id: string; event: string }[]
  commandHooks: readonly { event: string; command: string }[]
  promptBlocks: readonly PluginPromptBlockOut[]
  ui: readonly PluginUiContributionOut[]
  /** Follow-up bubbles the plugin suggests above the composer while enabled. */
  followUps: readonly PluginFollowUpOut[]
  /** Named runtime capability flags the plugin owns (pure behaviour, no tool). */
  capabilities: readonly PluginCapabilityOut[]
  /** Permission / sandbox relaxations the plugin may request while enabled. */
  permissions: readonly PluginPermissionOut[]
  storageNamespace?: string
}

/** Full snapshot for one plugin row in Settings. */
export interface PluginSummaryOut {
  id: string
  trust: PluginManifest['trust']
  stability: NonNullable<PluginManifest['stability']>
  name: string
  version?: string
  description?: string
  enabled: boolean
  source?: {
    kind: 'directory'
    path: string
    contentHash: string
  }
  contributions: PluginContributionsOut
  settings: readonly PluginSettingFieldOut[]
}

/** Given a manifest schema + a per-plugin `read`, project setting fields with current values. */
export function summarizePluginSettings(
  manifest: PluginManifest,
  readValue: (key: string) => unknown,
): readonly PluginSettingFieldOut[] {
  const schema = manifest.settings
  if (!schema) return []
  const out: PluginSettingFieldOut[] = []
  for (const [key, field] of Object.entries(schema)) {
    const raw = readValue(key)
    const value = normalizePluginSettingValue(field, raw)
    const entry: PluginSettingFieldOut = {
      id: key,
      kind: field.kind,
      title: field.title,
      value,
    }
    if (field.description !== undefined) entry.description = field.description
    if (field.default !== undefined) entry.default = field.default
    if (field.options !== undefined) entry.options = field.options
    out.push(entry)
  }
  return out
}

/**
 * Coerce a persisted value to the field's declared kind, falling back to the
 * default (or a kind-appropriate zero) when the stored value is missing or the
 * wrong type. Keeps the renderer from having to defend against corrupt storage.
 */
export function normalizePluginSettingValue(
  field: PluginSettingField,
  raw: unknown,
): boolean | string | number {
  switch (field.kind) {
    case 'boolean':
      if (typeof raw === 'boolean') return raw
      return typeof field.default === 'boolean' ? field.default : false
    case 'number':
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw
      return typeof field.default === 'number' ? field.default : 0
    case 'string':
      if (typeof raw === 'string') return raw
      return typeof field.default === 'string' ? field.default : ''
    case 'model':
      // A model id is a string; normalize exactly like `string` (any stored id
      // is honoured — the renderer keeps an offline/unknown id selectable — with
      // the declared default model id, or blank, as the fallback). The dynamic
      // catalogue is resolved renderer-side, so there is no `options` gate here.
      if (typeof raw === 'string') return raw
      return typeof field.default === 'string' ? field.default : ''
    case 'enum': {
      const options = field.options ?? []
      if (typeof raw === 'string' && options.includes(raw)) return raw
      if (typeof field.default === 'string' && options.includes(field.default)) return field.default
      return options[0] ?? ''
    }
  }
}

/** Project one registered plugin + its enablement + settings values into a plain snapshot. */
export function pluginToSummary(
  plugin: RegisteredPlugin,
  enabled: boolean,
  readSetting: (key: string) => unknown,
): PluginSummaryOut {
  const { manifest, contributions } = plugin
  const ui: PluginUiContributionOut[] = contributions.uiContributions.map((c) => {
    const entry: PluginUiContributionOut = { id: c.id, level: c.level }
    if (c.slot !== undefined) entry.slot = c.slot
    if (c.title !== undefined) entry.title = c.title
    if (c.panel?.kind !== undefined) entry.panelKind = c.panel.kind
    return entry
  })
  const followUps = contributions.followUps.map((f) => ({
    id: f.id,
    label: f.label,
    action: f.action ?? ('prompt' as const),
    when: f.when ?? ('always' as const),
  }))
  const commandHooks = (manifest.hooks ?? []).map((h) => ({ event: h.event, command: h.command }))
  const promptBlocks = contributions.promptBlocks.map((b) => ({ id: b.id, trust: b.trust }))
  const capabilities = contributions.capabilities.map((c) => {
    const entry: PluginCapabilityOut = { name: c.name, title: c.title }
    if (c.description !== undefined) entry.description = c.description
    return entry
  })
  const permissions = contributions.permissions.map((p) => {
    const entry: PluginPermissionOut = { name: p.name, title: p.title }
    if (p.description !== undefined) entry.description = p.description
    if (p.scope !== undefined) entry.scope = p.scope
    return entry
  })
  const contributionsOut: PluginContributionsOut = {
    toolNames: contributions.toolNames.slice(),
    modelRoutes: contributions.modelRoutes.map((route) => ({ ...route })),
    browserOrigins: contributions.browserOrigins.slice(),
    blockingHooks: contributions.blockingHooks.map((h) => ({ id: h.id, event: h.event })),
    asyncHooks: contributions.asyncHooks.map((h) => ({ id: h.id, event: h.event })),
    commandHooks,
    promptBlocks,
    ui,
    followUps,
    capabilities,
    permissions,
  }
  if (manifest.tools?.mcpServers !== undefined) {
    contributionsOut.mcpServersPath = manifest.tools.mcpServers
  }
  if (manifest.storage?.namespace !== undefined) {
    contributionsOut.storageNamespace = manifest.storage.namespace
  }

  const summary: PluginSummaryOut = {
    id: plugin.id,
    trust: plugin.trust,
    // Legacy/user manifests without the field fail safe: absence is not a
    // stability claim and must not be presented as one in Settings.
    stability: manifest.stability ?? 'experimental',
    name: manifest.name,
    enabled,
    contributions: contributionsOut,
    settings: summarizePluginSettings(manifest, readSetting),
  }
  if (manifest.version !== undefined) summary.version = manifest.version
  if (manifest.description !== undefined) summary.description = manifest.description
  return summary
}

/**
 * Walk the shared registry and snapshot every registered plugin for the Settings
 * plugin list. `readSetting(pluginId, key)` lets the host inject its persistence
 * backend; the projection stays a pure function of the registry + reader.
 */
export function summarizePlugins(
  registry: PluginRegistry,
  readSetting: (pluginId: string, key: string) => unknown,
): readonly PluginSummaryOut[] {
  return registry.all().map((plugin) => {
    return pluginToSummary(plugin, registry.isEnabled(plugin.id), (key) =>
      readSetting(plugin.id, key),
    )
  })
}
