// Pack-summary projection — P3 of the feature-pack layer.
//
// The Settings pack list ("about:addons of Copse") enumerates every registered
// pack's contributions so users can see what a pack adds before toggling it.
// The renderer never receives a live `RegisteredPack` (the executable
// contributions cross a process boundary); instead the host walks the shared
// `PackRegistry` and hands the renderer a plain-data snapshot of what each pack
// contributes and what its current pack-scoped settings values are. This module
// is that projection.
//
// Pure and Electron-free (execution-guidance rule 4): the projection only reads
// from the `RegisteredPack` shape and returns a serialisable summary. The host
// module `src/main/services/packs/pack-service.ts` is what wires it to
// electron-store persistence and IPC.
import type { PackRegistry } from './pack-registry.ts'
import type {
  PackManifest,
  PackSettingField,
  PackUiContribution,
  RegisteredPack,
} from './pack-manifest.ts'

/** Field kinds a pack-scoped setting can declare (kept in lockstep with `PackSettingKind`). */
type PackSettingKindOut = PackSettingField['kind']

/** One pack-scoped setting field rendered generically by Settings (P3). */
export interface PackSettingFieldOut {
  id: string
  kind: PackSettingKindOut
  title: string
  description?: string
  default?: boolean | string | number
  options?: readonly string[]
  /** Current persisted value, or the field's declared default. */
  value: boolean | string | number
}

/** One UI contribution enumerated for the Settings pack list. */
export interface PackUiContributionOut {
  id: string
  level: PackUiContribution['level']
  slot?: string
  title?: string
  panelKind?: 'list' | 'tree'
}

/** One prompt / steering block enumerated with its trust framing. */
export interface PackPromptBlockOut {
  id: string
  trust: 'trusted' | 'untrusted'
}

/** One runtime capability flag enumerated for the Settings pack list. */
export interface PackCapabilityOut {
  name: string
  title: string
  description?: string
}

/** One permission / sandbox relaxation enumerated for the Settings pack list. */
export interface PackPermissionOut {
  name: string
  title: string
  description?: string
  scope?: 'project' | 'workspace'
}

/** Contributions snapshot for one pack (renderer-facing plain data). */
export interface PackContributionsOut {
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
  promptBlocks: readonly PackPromptBlockOut[]
  ui: readonly PackUiContributionOut[]
  /** Named runtime capability flags the pack owns (pure behaviour, no tool). */
  capabilities: readonly PackCapabilityOut[]
  /** Permission / sandbox relaxations the pack may request while enabled. */
  permissions: readonly PackPermissionOut[]
  storageNamespace?: string
}

/** Full snapshot for one pack row in Settings. */
export interface PackSummaryOut {
  id: string
  trust: PackManifest['trust']
  name: string
  version?: string
  description?: string
  enabled: boolean
  source?: {
    kind: 'directory'
    path: string
    contentHash: string
  }
  contributions: PackContributionsOut
  settings: readonly PackSettingFieldOut[]
}

/** Given a manifest schema + a per-pack `read`, project setting fields with current values. */
export function summarizePackSettings(
  manifest: PackManifest,
  readValue: (key: string) => unknown,
): readonly PackSettingFieldOut[] {
  const schema = manifest.settings
  if (!schema) return []
  const out: PackSettingFieldOut[] = []
  for (const [key, field] of Object.entries(schema)) {
    const raw = readValue(key)
    const value = normalizePackSettingValue(field, raw)
    const entry: PackSettingFieldOut = {
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
export function normalizePackSettingValue(
  field: PackSettingField,
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

/** Project one registered pack + its enablement + settings values into a plain snapshot. */
export function packToSummary(
  pack: RegisteredPack,
  enabled: boolean,
  readSetting: (key: string) => unknown,
): PackSummaryOut {
  const { manifest, contributions } = pack
  const ui: PackUiContributionOut[] = contributions.uiContributions.map((c) => {
    const entry: PackUiContributionOut = { id: c.id, level: c.level }
    if (c.slot !== undefined) entry.slot = c.slot
    if (c.title !== undefined) entry.title = c.title
    if (c.panel?.kind !== undefined) entry.panelKind = c.panel.kind
    return entry
  })
  const commandHooks = (manifest.hooks ?? []).map((h) => ({ event: h.event, command: h.command }))
  const promptBlocks = contributions.promptBlocks.map((b) => ({ id: b.id, trust: b.trust }))
  const capabilities = contributions.capabilities.map((c) => {
    const entry: PackCapabilityOut = { name: c.name, title: c.title }
    if (c.description !== undefined) entry.description = c.description
    return entry
  })
  const permissions = contributions.permissions.map((p) => {
    const entry: PackPermissionOut = { name: p.name, title: p.title }
    if (p.description !== undefined) entry.description = p.description
    if (p.scope !== undefined) entry.scope = p.scope
    return entry
  })
  const contributionsOut: PackContributionsOut = {
    toolNames: contributions.toolNames.slice(),
    modelRoutes: contributions.modelRoutes.map((route) => ({ ...route })),
    browserOrigins: contributions.browserOrigins.slice(),
    blockingHooks: contributions.blockingHooks.map((h) => ({ id: h.id, event: h.event })),
    asyncHooks: contributions.asyncHooks.map((h) => ({ id: h.id, event: h.event })),
    commandHooks,
    promptBlocks,
    ui,
    capabilities,
    permissions,
  }
  if (manifest.tools?.mcpServers !== undefined) {
    contributionsOut.mcpServersPath = manifest.tools.mcpServers
  }
  if (manifest.storage?.namespace !== undefined) {
    contributionsOut.storageNamespace = manifest.storage.namespace
  }

  const summary: PackSummaryOut = {
    id: pack.id,
    trust: pack.trust,
    name: manifest.name,
    enabled,
    contributions: contributionsOut,
    settings: summarizePackSettings(manifest, readSetting),
  }
  if (manifest.version !== undefined) summary.version = manifest.version
  if (manifest.description !== undefined) summary.description = manifest.description
  return summary
}

/**
 * Walk the shared registry and snapshot every registered pack for the Settings
 * pack list. `readSetting(packId, key)` lets the host inject its persistence
 * backend; the projection stays a pure function of the registry + reader.
 */
export function summarizePacks(
  registry: PackRegistry,
  readSetting: (packId: string, key: string) => unknown,
): readonly PackSummaryOut[] {
  return registry.all().map((pack) => {
    return packToSummary(pack, registry.isEnabled(pack.id), (key) => readSetting(pack.id, key))
  })
}
