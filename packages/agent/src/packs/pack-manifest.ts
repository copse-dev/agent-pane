// Pack manifest + contributions — P1 of the feature-pack layer.
//
// A *pack* is a manifest-bundled feature (docs/plans/hooks-and-feature-packs.md,
// "Feature packs"). Its manifest extends the `plugin.json` shape Copse already
// loads (name / version / description / skills / mcpServers) with the remaining
// slots: hooks / prompt / ui / settings / storage. Following decision 15, the
// *declarative* manifest is shared by first-party and user packs; only
// first-party packs additionally supply the executable, typed contributions
// (native tools, in-process function hooks, real renderer views).
//
// This module lives in `packages/agent` and imports nothing from the host app —
// only hook *types* (execution-guidance rule 4). The published JSON schema
// (schemas/copse-pack.schema.json) validates the declarative manifest.
import type { AsyncHook, BlockingHook } from '../hooks/canonical-events.ts'

/** Whether a pack is shipped by Copse or installed by the user (decision 15). */
export type PackTrust = 'first-party' | 'user'

/**
 * UI contribution levels (Feature packs section of the plan):
 *  - 1: declarative cards (the hook-card family).
 *  - 2: a named panel slot fed structured pack data, host renders generically.
 *  - 3: a real renderer view (first-party privilege).
 */
export type PackUiLevel = 1 | 2 | 3

/** One UI contribution a pack declares (decision 15; levels 1–3). */
export interface PackUiContribution {
  /** Stable id for the contribution (Settings enumeration in P3). */
  id: string
  level: PackUiLevel
  /** Named host slot this mounts into (level 2/3); omitted for level-1 cards. */
  slot?: string
  /** Human title (Settings pack-list enumeration, P3). */
  title?: string
}

/**
 * A prompt / steering block a pack contributes, carrying trust framing (plan).
 * A `trusted` (first-party) block is injected verbatim; an `untrusted` (user)
 * block is delimited as data, matching the skills trust model.
 */
export interface PackPromptBlock {
  id: string
  text: string
  trust: 'trusted' | 'untrusted'
}

/** Field kinds a pack-scoped setting can declare (rendered generically in P3). */
export type PackSettingKind = 'boolean' | 'string' | 'number' | 'enum'

/** One pack-scoped setting, rendered generically in Settings (P3). */
export interface PackSettingField {
  kind: PackSettingKind
  title: string
  description?: string
  default?: boolean | string | number
  /** Allowed values for an `enum` field. */
  options?: readonly string[]
}

/** Pack-scoped settings schema, keyed by setting id (rendered generically, P3). */
export type PackSettingsSchema = Record<string, PackSettingField>

/**
 * Namespaced storage declaration. Pack state is keyed under this namespace and
 * **survives disable** — like a disabled browser extension's data (decision 17).
 */
export interface PackStorageDecl {
  namespace: string
}

/**
 * How a pack declares its tools in the manifest (decision 15):
 *  - `native`: native tool names contributed to the model tool list (first-party).
 *  - `mcpServers`: a path to an MCP config file (user packs), like the existing
 *    plugin.json `mcpServers` field.
 */
export interface PackToolsDecl {
  native?: readonly string[]
  mcpServers?: string
}

/**
 * A command-hook declaration in a user pack's manifest (scaffold for user packs;
 * the concrete dialect wiring already exists under `src/main/services/hooks/`).
 * First-party function hooks are not declared here — they are typed runtime
 * contributions on {@link RegisteredPack} (decision 15).
 */
export interface PackCommandHookDecl {
  event: string
  command: string
}

/**
 * The declarative pack manifest — a superset of the plugin.json shape Copse
 * already loads. This is the JSON-serializable contract the published schema
 * validates. The *executable* first-party contributions (function hooks, native
 * tool registrations) live on {@link RegisteredPack.contributions}, never here,
 * so a manifest stays serializable and a user pack can never smuggle code.
 */
export interface PackManifest {
  /** Pack id / name (plugin.json `name`). */
  name: string
  version?: string
  description?: string
  /** Shipped by Copse vs user-installed (decision 15). */
  trust: PackTrust
  /** Existing plugin.json slot: relative skills directory. */
  skills?: string
  /** Tools slot: native names (first-party) or an MCP config path (user). */
  tools?: PackToolsDecl
  /** Command-hook declarations (user packs). */
  hooks?: readonly PackCommandHookDecl[]
  prompt?: readonly PackPromptBlock[]
  ui?: readonly PackUiContribution[]
  settings?: PackSettingsSchema
  storage?: PackStorageDecl
}

/**
 * The executable contributions a *registered* pack supplies **while enabled**.
 * Disabling a pack removes all of these from new work in one action (atomic
 * enable/disable); its storage is untouched (decision 17). First-party packs
 * fill these with typed values; a user pack's runtime contributions are derived
 * host-side from its manifest (command hooks, MCP tools) in later phases.
 */
export interface PackContributions {
  /** Native tool names added to the model tool list while enabled. */
  readonly toolNames: readonly string[]
  /** Blocking function hooks registered while enabled (first-party). */
  readonly blockingHooks: readonly BlockingHook[]
  /** Async (detached) function hooks registered while enabled (first-party). */
  readonly asyncHooks: readonly AsyncHook[]
  /** Prompt / steering blocks folded into assembly while enabled. */
  readonly promptBlocks: readonly PackPromptBlock[]
  /** UI contributions mounted for *new* content while enabled (decision 17). */
  readonly uiContributions: readonly PackUiContribution[]
}

/** Contributions a pack with nothing to offer registers (the P1 skeleton). */
export const EMPTY_PACK_CONTRIBUTIONS: PackContributions = {
  toolNames: [],
  blockingHooks: [],
  asyncHooks: [],
  promptBlocks: [],
  uiContributions: [],
}

/**
 * A pack grouped in the registry: its declarative manifest plus its live
 * contributions. `id` is the grouping key across tools / hooks / prompt / ui /
 * settings / storage — the whole point of pack grouping (decision 15).
 */
export interface RegisteredPack {
  readonly id: string
  readonly trust: PackTrust
  readonly manifest: PackManifest
  readonly contributions: PackContributions
}

/**
 * Build a {@link RegisteredPack} from a manifest and a partial contribution set,
 * defaulting the unfilled slots to empty. Keeps first-party pack definitions
 * terse (they usually contribute only one or two slots) without hand-writing
 * every empty array.
 */
export function definePack(
  manifest: PackManifest,
  contributions: Partial<PackContributions> = {},
): RegisteredPack {
  return {
    id: manifest.name,
    trust: manifest.trust,
    manifest,
    contributions: { ...EMPTY_PACK_CONTRIBUTIONS, ...contributions },
  }
}

/**
 * Map a raw `plugin.json`-shaped object into a {@link PackManifest} (scaffold for
 * user packs). The existing top-level `skills` / `mcpServers` fields fold into
 * the pack slots (`mcpServers` → `tools.mcpServers`); the new pack slots are
 * carried through when present. Pure and Electron-free — the host disk discovery
 * that feeds this a parsed plugin.json lands in a later phase (P3/P4).
 */
export function packManifestFromPluginJson(raw: {
  name?: string
  version?: string
  description?: string
  skills?: string
  mcpServers?: string
  tools?: PackToolsDecl
  hooks?: readonly PackCommandHookDecl[]
  prompt?: readonly PackPromptBlock[]
  ui?: readonly PackUiContribution[]
  settings?: PackSettingsSchema
  storage?: PackStorageDecl
}): PackManifest {
  const tools: PackToolsDecl = { ...raw.tools }
  if (raw.mcpServers && tools.mcpServers === undefined) tools.mcpServers = raw.mcpServers

  const manifest: PackManifest = {
    // A discovered plugin.json is always a user pack (decision 15: user packs
    // share the manifest; first-party packs are defined in code, not on disk).
    name: raw.name?.trim() || 'unnamed-pack',
    trust: 'user',
  }
  if (raw.version) manifest.version = raw.version
  if (raw.description) manifest.description = raw.description
  if (raw.skills) manifest.skills = raw.skills
  if (tools.native !== undefined || tools.mcpServers !== undefined) manifest.tools = tools
  if (raw.hooks) manifest.hooks = raw.hooks
  if (raw.prompt) manifest.prompt = raw.prompt
  if (raw.ui) manifest.ui = raw.ui
  if (raw.settings) manifest.settings = raw.settings
  if (raw.storage) manifest.storage = raw.storage
  return manifest
}
