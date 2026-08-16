// Plugin manifest + contributions — P1 of the feature-plugin layer.
//
// A *plugin* is a manifest-bundled feature (docs/plans/hooks-and-feature-packs.md,
// "Feature plugins"). Its manifest extends the `plugin.json` shape Copse already
// loads (name / version / description / skills / mcpServers) with the remaining
// slots: hooks / prompt / ui / settings / storage. Following decision 15, the
// *declarative* manifest is shared by first-party and user plugins. First-party
// plugins may supply executable typed contributions in-process; an explicitly
// selected user plugin may instead provide tools and thread models through one
// isolated runtime. The manifest describes those concrete behaviors; the host
// supplies only their bounded invocation contracts.
//
// This module lives in `packages/agent` and imports nothing from the host app —
// only hook *types* (execution-guidance rule 4). The published JSON schema
// (schemas/copse-plugin.schema.json) validates the declarative manifest.
import type { AsyncHook, BlockingHook } from '../hooks/canonical-events.ts'
import type { PanelContributionDecl } from './plugin-panel.ts'

/** Host-assigned plugin trust class; disk manifests cannot self-promote. */
export type PluginTrust = 'first-party' | 'user'

/** Product-support status shown before a user enables a plugin (decision 19). */
export type PluginStability = 'stable' | 'experimental'

/**
 * UI contribution levels (Feature plugins section of the plan):
 *  - 1: declarative cards (the hook-card family).
 *  - 2: a named panel slot fed structured plugin data, host renders generically.
 *  - 3: a real renderer view (first-party privilege).
 */
export type PluginUiLevel = 1 | 2 | 3

/** One UI contribution a plugin declares (decision 15; levels 1–3). */
export interface PluginUiContribution {
  /** Stable id for the contribution (Settings enumeration in P3). */
  id: string
  level: PluginUiLevel
  /** Named host slot this mounts into (level 2/3); omitted for level-1 cards. */
  slot?: string
  /** Human title (Settings plugin-list enumeration, P3). */
  title?: string
  /**
   * Level-2 refinement (P2). When `level: 2`, `panel` declares the shape of the
   * plugin data the host will render generically (`list` vs `tree`). Omitted for
   * level 1 (declarative cards) and level 3 (real renderer view — the plugin ships
   * the component itself). The host validates incoming `panel_update` payloads
   * against this shape (P3 wiring); level-2 contributions without a `panel`
   * decl are rejected at registration time to keep the invariant mechanical.
   */
  panel?: PanelContributionDecl
}

/**
 * A named runtime *capability* a plugin owns — a pure cross-cutting behaviour flag
 * that adds no tool, hook, prompt, or panel. Some Experimental features (the
 * MCP-UI canvas, the DevTools shortcut) gate behaviour that already lives across
 * main + renderer; they can't be expressed as any of the other contribution
 * kinds. A capability is that missing kind: a stable `name` any subsystem reads
 * through {@link PluginRegistry.isCapabilityActive} (the single seam that replaces
 * scattered `getSetting` reads), plus a human `title`/`description` so the
 * Settings plugin list can enumerate what the toggle actually does.
 */
export interface PluginCapabilityDecl {
  /** Stable capability id — the flag name subsystems read via `isCapabilityActive`. */
  name: string
  /** Human title for the Settings plugin-list enumeration (P3). */
  title: string
  /** Optional human description shown alongside the title. */
  description?: string
}

/**
 * A permission / sandbox relaxation a plugin DECLARES it may request — the missing
 * "what authority does this plugin open" contribution kind (issue #1190). Some
 * features are, in essence, a sandbox relaxation gated by a permission prompt:
 * the Background tasks plugin can opt a task into binding a loopback port, which
 * relaxes the default sandbox (workspace-only, no network) to allow `localhost`
 * binding for the process lifetime, gated by a per-project grant through the
 * permission-gate. A declared relaxation is grantable ONLY while the owning plugin
 * is enabled — the permission-gate resolves it through
 * {@link PluginRegistry.isPermissionDeclared}, so disabling the plugin revokes the
 * authority in the same atomic flag flip that drops its tools/hooks. The
 * declaration also feeds the Settings plugin-list enumeration and the future
 * install-time capability/permission review (#1082).
 */
export interface PluginPermissionDecl {
  /** Stable relaxation id the permission-gate resolves via `isPermissionDeclared`. */
  name: string
  /** Human title for the Settings plugin-list enumeration (P3). */
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
 * What clicking a plugin-contributed follow-up bubble does.
 *  - `prompt` — send the decl's `prompt` to the agent, exactly what every
 *    follow-up bubble did before packs could contribute one.
 *  - `model-compare` — open the comparison model picker, then run the
 *    comparison with what the user chose.
 *
 * A host action is a first-party privilege. It drives app UI (and, for
 * `model-compare`, spends money) without passing through the agent, so a
 * discovered manifest is forced back to `prompt` in
 * {@link pluginManifestFromPluginJson} and {@link PluginRegistry.register} rejects a
 * non-first-party plugin that contributes one — the same tiering the `trusted`
 * prompt block gets.
 */
export type PluginFollowUpAction = 'prompt' | 'model-compare'

/**
 * When the host should offer a plugin's bubble. A bounded vocabulary rather than a
 * predicate: the manifest is plain JSON, so a plugin names a condition the host
 * *already* computes for its own deterministic bubbles (the git/PR workspace
 * context) instead of shipping code that runs at the end of every turn.
 *
 * `workspace-changes` — only when the working tree has uncommitted changes.
 * `always` — whenever the pack is enabled (the default).
 */
export type PluginFollowUpCondition = 'always' | 'workspace-changes'

/**
 * A follow-up bubble a plugin suggests above the composer — the offer-shaped
 * alternative to interrupting with a modal. The host decides *whether* to show
 * it (`when`) and *what the click does* (`action`); the plugin only declares it.
 */
export interface PluginFollowUpDecl {
  /**
   * Stable suggestion id — the bubble's `data-id` and its dedupe key. A decl
   * that collides with a host preset id (`changes`, `debug-ci`, …) loses: the
   * deterministic signal is already on screen.
   */
  id: string
  /** Bubble text. Keep it short — bubbles sit in one row above the composer. */
  label: string
  /** Sent to the agent when `action` is `prompt`; unused by host actions. */
  prompt?: string
  /** Defaults to `prompt`. */
  action?: PluginFollowUpAction
  /** Defaults to `always`. */
  when?: PluginFollowUpCondition
}

/**
 * A prompt / steering block a plugin contributes, carrying trust framing (plan).
 * A `trusted` (first-party) block is injected verbatim; an `untrusted` (user)
 * block is delimited as data, matching the skills trust model.
 */
export interface PluginPromptBlock {
  id: string
  text: string
  trust: 'trusted' | 'untrusted'
}

/**
 * Field kinds a plugin-scoped setting can declare (rendered generically in P3).
 *
 * A `model` field resolves the live configured-model catalogue *host-side* at
 * read time and renders as the grouped model picker (Settings → Plugins), so a
 * model-parameterised plugin owns its own model configuration instead of leaving
 * hand-written `<select>` blocks stranded in the settings dialog. Its value is a
 * model id string with an optional `default`; unlike `enum` it carries no static
 * `options` array — the option list is dynamic and injected by the renderer from
 * the same catalogue the footer/settings model pickers use.
 *
 * (A future `role` field kind — resolving a role registry — is a deliberate
 * extension seam here; this phase ships only `model`.)
 */
export type PluginSettingKind = 'boolean' | 'string' | 'number' | 'enum' | 'model'

/** One plugin-scoped setting, rendered generically in Settings (P3). */
export interface PluginSettingField {
  kind: PluginSettingKind
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

/** Plugin-scoped settings schema, keyed by setting id (rendered generically, P3). */
export type PluginSettingsSchema = Record<string, PluginSettingField>

/**
 * Namespaced storage declaration. Plugin state is keyed under this namespace and
 * **survives disable** — like a disabled browser extension's data (decision 17).
 */
export interface PluginStorageDecl {
  namespace: string
}

/**
 * How a plugin declares its tools in the manifest (decision 15):
 *  - `native`: native tool names contributed to the model tool list (first-party).
 *  - `acpTools`: the subset of `native` tools safe to offer to external ACP
 *    agents through Copse's authenticated localhost native-tool bridge
 *    (first-party only).
 *  - `provides`: tool ids implemented by an explicitly selected user plugin's
 *    shared top-level runtime.
 *  - `mcpServers`: a path to an MCP config file (user plugins), like the existing
 *    plugin.json `mcpServers` field.
 */
export interface PluginToolRuntimeDecl {
  entrypoint: string
  apiVersion: 1
}

export interface PluginToolsDecl {
  native?: readonly string[]
  acpTools?: readonly string[]
  provides?: readonly string[]
  mcpServers?: string
}

/** One whole-thread model route an explicitly selected plugin contributes. */
export interface PluginModelRouteDecl {
  id: string
  label: string
  group?: string
  description?: string
  supportsImages?: boolean
}

export interface PluginModelsDecl {
  provides: readonly PluginModelRouteDecl[]
}

/**
 * Interactive browser-pane behavior for an explicitly selected plugin. Origins
 * are exact URL origins (scheme + host + optional port), validated host-side.
 * The runtime receives only named browser operations scoped to these origins;
 * this is not a network grant or generic host gateway.
 */
export interface PluginBrowserDecl {
  origins: readonly string[]
}

/**
 * A command-hook declaration in a user plugin's manifest (scaffold for user plugins;
 * the concrete dialect wiring already exists under `src/main/services/hooks/`).
 * First-party function hooks are not declared here — they are typed runtime
 * contributions on {@link RegisteredPlugin} (decision 15).
 */
export interface PluginCommandHookDecl {
  event: string
  command: string
}

/**
 * The declarative plugin manifest — a superset of the plugin.json shape Copse
 * already loads. This is the JSON-serializable contract the published schema
 * validates. First-party function hooks and in-process tools live on
 * {@link RegisteredPlugin.contributions}; a selected user plugin may declare the
 * isolated runtime shared by its tool and model behaviors here.
 */
export interface PluginManifest {
  /** Plugin id / name (plugin.json `name`). */
  name: string
  version?: string
  description?: string
  /** Shipped by Copse vs user-installed (decision 15). */
  trust: PluginTrust
  /** Product-support status. Omitted user-plugin values fail safe to `experimental`. */
  stability?: PluginStability
  /** Existing plugin.json slot: relative skills directory. */
  skills?: string
  /** Tools behavior: first-party names, selected-plugin runtime, or MCP config. */
  tools?: PluginToolsDecl
  /** Thread-model behavior supplied by an explicitly selected plugin. */
  models?: PluginModelsDecl
  /** Exact origins the plugin may operate in the visible browser pane. */
  browser?: PluginBrowserDecl
  /** Shared isolated runtime for selected-plugin executable behaviors. */
  runtime?: PluginToolRuntimeDecl
  /** Command-hook declarations (user plugins). */
  hooks?: readonly PluginCommandHookDecl[]
  prompt?: readonly PluginPromptBlock[]
  ui?: readonly PluginUiContribution[]
  /** Follow-up bubbles the plugin suggests above the composer while enabled. */
  followUps?: readonly PluginFollowUpDecl[]
  /** Named runtime capability flags the plugin owns (pure behaviour, no tool). */
  capabilities?: readonly PluginCapabilityDecl[]
  /** Permission / sandbox relaxations the plugin may request while enabled. */
  permissions?: readonly PluginPermissionDecl[]
  settings?: PluginSettingsSchema
  storage?: PluginStorageDecl
}

/**
 * The executable contributions a *registered* plugin supplies **while enabled**.
 * Disabling a plugin removes all of these from new work in one action (atomic
 * enable/disable); its storage is untouched (decision 17). First-party plugins
 * fill these with typed values; a user plugin's runtime contributions are derived
 * host-side from its manifest (command hooks, MCP tools) in later phases.
 */
export interface PluginContributions {
  /** Native tool names added to the model tool list while enabled. */
  readonly toolNames: readonly string[]
  /** Thread models offered in the footer while this plugin is enabled. */
  readonly modelRoutes: readonly PluginModelRouteDecl[]
  /** Exact interactive browser origins available while this plugin is enabled. */
  readonly browserOrigins: readonly string[]
  /** Blocking function hooks registered while enabled (first-party). */
  readonly blockingHooks: readonly BlockingHook[]
  /** Async (detached) function hooks registered while enabled (first-party). */
  readonly asyncHooks: readonly AsyncHook[]
  /** Prompt / steering blocks folded into assembly while enabled. */
  readonly promptBlocks: readonly PluginPromptBlock[]
  /** UI contributions mounted for *new* content while enabled (decision 17). */
  readonly uiContributions: readonly PluginUiContribution[]
  /**
   * Follow-up bubbles offered above the composer while enabled. Like every other
   * contribution kind these are consulted only for *new* work — a bubble already
   * on screen when the pack is disabled is stale UI, not history, and clears on
   * the next turn.
   */
  readonly followUps: readonly PluginFollowUpDecl[]
  /**
   * Runtime capability flags active while enabled. A capability is "active" iff
   * some enabled plugin declares it (see {@link PluginRegistry.isCapabilityActive});
   * disabling the plugin drops it in the same atomic flag flip as its other
   * contribution kinds.
   */
  readonly capabilities: readonly PluginCapabilityDecl[]
  /**
   * Permission / sandbox relaxations the plugin may request while enabled. A
   * relaxation is grantable iff some enabled plugin declares it (see
   * {@link PluginRegistry.isPermissionDeclared}); disabling the owning plugin drops
   * it in the same atomic flag flip as its other contribution kinds, so the
   * permission-gate stops honouring the authority the moment the plugin is off.
   */
  readonly permissions: readonly PluginPermissionDecl[]
}

/** Contributions a plugin with nothing to offer registers (the P1 skeleton). */
export const EMPTY_PLUGIN_CONTRIBUTIONS: PluginContributions = {
  toolNames: [],
  modelRoutes: [],
  browserOrigins: [],
  blockingHooks: [],
  asyncHooks: [],
  promptBlocks: [],
  uiContributions: [],
  followUps: [],
  capabilities: [],
  permissions: [],
}

/**
 * A plugin grouped in the registry: its declarative manifest plus its live
 * contributions. `id` is the grouping key across tools / hooks / prompt / ui /
 * settings / storage — the whole point of plugin grouping (decision 15).
 */
export interface RegisteredPlugin {
  readonly id: string
  readonly trust: PluginTrust
  readonly manifest: PluginManifest
  readonly contributions: PluginContributions
}

/**
 * Build a {@link RegisteredPlugin} from a manifest and a partial contribution set,
 * defaulting the unfilled slots to empty. Keeps first-party plugin definitions
 * terse (they usually contribute only one or two slots) without hand-writing
 * every empty array.
 */
export function definePlugin(
  manifest: PluginManifest &
    (
      | { trust: 'first-party'; stability: PluginStability }
      | { trust: 'user'; stability?: PluginStability }
    ),
  contributions: Partial<PluginContributions> = {},
): RegisteredPlugin {
  return {
    id: manifest.name,
    trust: manifest.trust,
    manifest,
    contributions: { ...EMPTY_PLUGIN_CONTRIBUTIONS, ...contributions },
  }
}

/**
 * Map a raw `plugin.json`-shaped object into a {@link PluginManifest} (scaffold for
 * user plugins). The existing top-level `skills` / `mcpServers` fields fold into
 * the plugin slots (`mcpServers` → `tools.mcpServers`); the new plugin slots are
 * carried through when present. Pure and Electron-free — the host disk discovery
 * that feeds this a parsed plugin.json lands in a later phase (P3/P4).
 */
export function pluginManifestFromPluginJson(
  raw: {
    name?: string
    version?: string
    description?: string
    stability?: PluginStability
    skills?: string
    mcpServers?: string
    tools?: PluginToolsDecl
    models?: PluginModelsDecl
    browser?: PluginBrowserDecl
    runtime?: PluginToolRuntimeDecl
    hooks?: readonly PluginCommandHookDecl[]
    prompt?: readonly PluginPromptBlock[]
    ui?: readonly PluginUiContribution[]
    followUps?: readonly PluginFollowUpDecl[]
    capabilities?: readonly PluginCapabilityDecl[]
    permissions?: readonly PluginPermissionDecl[]
    settings?: PluginSettingsSchema
    storage?: PluginStorageDecl
  },
  opts?: {
    /**
     * Distinguishing hint (e.g. the plugin directory basename) used when the
     * file declares no name. Without it two nameless plugin.json files both map
     * to `unnamed-plugin` and the second registration throws, killing both.
     */
    sourceHint?: string
  },
): PluginManifest {
  const tools: PluginToolsDecl = { ...raw.tools }
  if (raw.mcpServers && tools.mcpServers === undefined) tools.mcpServers = raw.mcpServers
  const requestedName = raw.name?.trim()
  const fallbackName = opts?.sourceHint ? `unnamed-plugin-${opts.sourceHint}` : 'unnamed-plugin'

  const manifest: PluginManifest = {
    // A discovered plugin.json is always a user plugin (decision 15: user plugins
    // share the manifest; first-party plugins are defined in code, not on disk).
    name: requestedName === undefined || requestedName.length === 0 ? fallbackName : requestedName,
    trust: 'user',
    // A third-party plugin that makes no support claim must never look stable by
    // omission. Authors may explicitly declare stable once discovery lands.
    stability: raw.stability ?? 'experimental',
  }
  if (raw.version) manifest.version = raw.version
  if (raw.description) manifest.description = raw.description
  if (raw.skills) manifest.skills = raw.skills
  if (
    tools.native !== undefined ||
    tools.acpTools !== undefined ||
    tools.provides !== undefined ||
    tools.mcpServers !== undefined
  ) {
    manifest.tools = tools
  }
  if (raw.models) manifest.models = raw.models
  if (raw.browser) manifest.browser = raw.browser
  if (raw.runtime) manifest.runtime = raw.runtime
  if (raw.hooks) manifest.hooks = raw.hooks
  // A user plugin's prompt blocks are NEVER trusted, whatever the file claims:
  // `trust: 'trusted'` means verbatim injection past the untrusted-data
  // delimiting, which is a prompt-injection escalation a repo-supplied
  // plugin.json must not be able to self-grant. Force every block to
  // 'untrusted'; only first-party (code-defined) plugins may declare trusted
  // blocks (decision 15's capability tiering applied to prompt).
  if (raw.prompt) manifest.prompt = raw.prompt.map((b) => ({ ...b, trust: 'untrusted' }))
  if (raw.ui) manifest.ui = raw.ui
  // A discovered pack may *suggest* a follow-up, never bind one to a host action:
  // `model-compare` opens a picker that spends money, and the rest of the action
  // vocabulary drives app UI outside the agent. Force every declared action back
  // to `prompt` here (the same self-grant this function denies prompt blocks), so
  // a repo-supplied plugin.json can only ever put words in the composer.
  if (raw.followUps) manifest.followUps = raw.followUps.map((f) => ({ ...f, action: 'prompt' }))
  if (raw.capabilities) manifest.capabilities = raw.capabilities
  if (raw.permissions) manifest.permissions = raw.permissions
  if (raw.settings) manifest.settings = raw.settings
  if (raw.storage) manifest.storage = raw.storage
  return manifest
}
