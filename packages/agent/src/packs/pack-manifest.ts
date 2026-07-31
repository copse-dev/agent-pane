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
import type { PanelContributionDecl } from './pack-panel.ts'

/** Whether a pack is shipped by Copse or installed by the user (decision 15). */
export type PackTrust = 'first-party' | 'user'

/** Product-support status shown before a user enables a pack (decision 19). */
export type PackStability = 'stable' | 'experimental'

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
  /**
   * Level-2 refinement (P2). When `level: 2`, `panel` declares the shape of the
   * pack data the host will render generically (`list` vs `tree`). Omitted for
   * level 1 (declarative cards) and level 3 (real renderer view — the pack ships
   * the component itself). The host validates incoming `panel_update` payloads
   * against this shape (P3 wiring); level-2 contributions without a `panel`
   * decl are rejected at registration time to keep the invariant mechanical.
   */
  panel?: PanelContributionDecl
}

/**
 * A named runtime *capability* a pack owns — a pure cross-cutting behaviour flag
 * that adds no tool, hook, prompt, or panel. Some Experimental features (the
 * MCP-UI canvas, the DevTools shortcut) gate behaviour that already lives across
 * main + renderer; they can't be expressed as any of the other contribution
 * kinds. A capability is that missing kind: a stable `name` any subsystem reads
 * through {@link PackRegistry.isCapabilityActive} (the single seam that replaces
 * scattered `getSetting` reads), plus a human `title`/`description` so the
 * Settings pack list can enumerate what the toggle actually does.
 */
export interface PackCapabilityDecl {
  /** Stable capability id — the flag name subsystems read via `isCapabilityActive`. */
  name: string
  /** Human title for the Settings pack-list enumeration (P3). */
  title: string
  /** Optional human description shown alongside the title. */
  description?: string
}

/**
 * A permission / sandbox relaxation a pack DECLARES it may request — the missing
 * "what authority does this pack open" contribution kind (issue #1190). Some
 * features are, in essence, a sandbox relaxation gated by a permission prompt:
 * the Background tasks pack can opt a task into binding a loopback port, which
 * relaxes the default sandbox (workspace-only, no network) to allow `localhost`
 * binding for the process lifetime, gated by a per-project grant through the
 * permission-gate. A declared relaxation is grantable ONLY while the owning pack
 * is enabled — the permission-gate resolves it through
 * {@link PackRegistry.isPermissionDeclared}, so disabling the pack revokes the
 * authority in the same atomic flag flip that drops its tools/hooks. The
 * declaration also feeds the Settings pack-list enumeration and the future
 * install-time capability/permission review (#1082).
 */
export interface PackPermissionDecl {
  /** Stable relaxation id the permission-gate resolves via `isPermissionDeclared`. */
  name: string
  /** Human title for the Settings pack-list enumeration (P3). */
  title: string
  /** Optional human description of the authority the relaxation opens. */
  description?: string
  /**
   * The granularity of the permission grant that gates the relaxation. `project`
   * — a per-project grant (e.g. the loopback-bind grant, keyed by execution
   * root); `workspace` — a broader per-workspace grant. Defaults to `project`
   * when omitted (the tighter scope).
   */
  scope?: 'project' | 'workspace'
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

/**
 * Field kinds a pack-scoped setting can declare (rendered generically in P3).
 *
 * A `model` field resolves the live configured-model catalogue *host-side* at
 * read time and renders as the grouped model picker (Settings → Packs), so a
 * model-parameterised pack owns its own model configuration instead of leaving
 * hand-written `<select>` blocks stranded in the settings dialog. Its value is a
 * model id string with an optional `default`; unlike `enum` it carries no static
 * `options` array — the option list is dynamic and injected by the renderer from
 * the same catalogue the footer/settings model pickers use.
 *
 * (A future `role` field kind — resolving a role registry — is a deliberate
 * extension seam here; this phase ships only `model`.)
 */
export type PackSettingKind = 'boolean' | 'string' | 'number' | 'enum' | 'model'

/** One pack-scoped setting, rendered generically in Settings (P3). */
export interface PackSettingField {
  kind: PackSettingKind
  title: string
  description?: string
  /** Default value (a model id string for `kind: 'model'`). */
  default?: boolean | string | number
  /**
   * Allowed values for an `enum` field. NOT used by `model` (its option list is
   * the dynamic model catalogue, resolved host-side at read time — never baked
   * into the manifest).
   */
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
 *  - `acpTools`: the subset of `native` tools safe to offer to external ACP
 *    agents through Copse's authenticated localhost native-tool bridge
 *    (first-party only).
 *  - `mcpServers`: a path to an MCP config file (user packs), like the existing
 *    plugin.json `mcpServers` field.
 */
export interface PackToolsDecl {
  native?: readonly string[]
  acpTools?: readonly string[]
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
  /** Product-support status. Omitted user-pack values fail safe to `experimental`. */
  stability?: PackStability
  /** Existing plugin.json slot: relative skills directory. */
  skills?: string
  /** Tools slot: native names (first-party) or an MCP config path (user). */
  tools?: PackToolsDecl
  /** Command-hook declarations (user packs). */
  hooks?: readonly PackCommandHookDecl[]
  prompt?: readonly PackPromptBlock[]
  ui?: readonly PackUiContribution[]
  /** Named runtime capability flags the pack owns (pure behaviour, no tool). */
  capabilities?: readonly PackCapabilityDecl[]
  /** Permission / sandbox relaxations the pack may request while enabled. */
  permissions?: readonly PackPermissionDecl[]
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
  /**
   * Runtime capability flags active while enabled. A capability is "active" iff
   * some enabled pack declares it (see {@link PackRegistry.isCapabilityActive});
   * disabling the pack drops it in the same atomic flag flip as its other
   * contribution kinds.
   */
  readonly capabilities: readonly PackCapabilityDecl[]
  /**
   * Permission / sandbox relaxations the pack may request while enabled. A
   * relaxation is grantable iff some enabled pack declares it (see
   * {@link PackRegistry.isPermissionDeclared}); disabling the owning pack drops
   * it in the same atomic flag flip as its other contribution kinds, so the
   * permission-gate stops honouring the authority the moment the pack is off.
   */
  readonly permissions: readonly PackPermissionDecl[]
}

/** Contributions a pack with nothing to offer registers (the P1 skeleton). */
export const EMPTY_PACK_CONTRIBUTIONS: PackContributions = {
  toolNames: [],
  blockingHooks: [],
  asyncHooks: [],
  promptBlocks: [],
  uiContributions: [],
  capabilities: [],
  permissions: [],
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
  manifest: PackManifest &
    (
      | { trust: 'first-party'; stability: PackStability }
      | { trust: 'user'; stability?: PackStability }
    ),
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
export function packManifestFromPluginJson(
  raw: {
    name?: string
    version?: string
    description?: string
    stability?: PackStability
    skills?: string
    mcpServers?: string
    tools?: PackToolsDecl
    hooks?: readonly PackCommandHookDecl[]
    prompt?: readonly PackPromptBlock[]
    ui?: readonly PackUiContribution[]
    capabilities?: readonly PackCapabilityDecl[]
    permissions?: readonly PackPermissionDecl[]
    settings?: PackSettingsSchema
    storage?: PackStorageDecl
  },
  opts?: {
    /**
     * Distinguishing hint (e.g. the plugin directory basename) used when the
     * file declares no name. Without it two nameless plugin.json files both map
     * to `unnamed-pack` and the second registration throws, killing both.
     */
    sourceHint?: string
  },
): PackManifest {
  const tools: PackToolsDecl = { ...raw.tools }
  if (raw.mcpServers && tools.mcpServers === undefined) tools.mcpServers = raw.mcpServers
  const requestedName = raw.name?.trim()
  const fallbackName = opts?.sourceHint ? `unnamed-pack-${opts.sourceHint}` : 'unnamed-pack'

  const manifest: PackManifest = {
    // A discovered plugin.json is always a user pack (decision 15: user packs
    // share the manifest; first-party packs are defined in code, not on disk).
    name: requestedName === undefined || requestedName.length === 0 ? fallbackName : requestedName,
    trust: 'user',
    // A third-party pack that makes no support claim must never look stable by
    // omission. Authors may explicitly declare stable once discovery lands.
    stability: raw.stability ?? 'experimental',
  }
  if (raw.version) manifest.version = raw.version
  if (raw.description) manifest.description = raw.description
  if (raw.skills) manifest.skills = raw.skills
  if (
    tools.native !== undefined ||
    tools.acpTools !== undefined ||
    tools.mcpServers !== undefined
  ) {
    manifest.tools = tools
  }
  if (raw.hooks) manifest.hooks = raw.hooks
  // A user pack's prompt blocks are NEVER trusted, whatever the file claims:
  // `trust: 'trusted'` means verbatim injection past the untrusted-data
  // delimiting, which is a prompt-injection escalation a repo-supplied
  // plugin.json must not be able to self-grant. Force every block to
  // 'untrusted'; only first-party (code-defined) packs may declare trusted
  // blocks (decision 15's capability tiering applied to prompt).
  if (raw.prompt) manifest.prompt = raw.prompt.map((b) => ({ ...b, trust: 'untrusted' }))
  if (raw.ui) manifest.ui = raw.ui
  if (raw.capabilities) manifest.capabilities = raw.capabilities
  if (raw.permissions) manifest.permissions = raw.permissions
  if (raw.settings) manifest.settings = raw.settings
  if (raw.storage) manifest.storage = raw.storage
  return manifest
}
