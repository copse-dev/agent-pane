// The plugin registry — P1 of the feature-plugin layer.
//
// One registry groups every plugin's contributions by plugin id (tools / hooks /
// prompt / ui / settings / storage) and owns the plugin *lifecycle*: atomic
// enable/disable. Disabling a plugin removes all of its contributions from **new
// work** in one action — tools leave the model tool list, hooks stop firing,
// prompt blocks drop out, UI contributions stop mounting for new content — while
// its storage persists like a disabled browser extension's data (decision 17).
//
// Critically, the registry is consulted only for *new work*. History / transcript
// rendering resolves from shipped renderer code + spine data and **never** calls
// into this registry (decision 17); the registry exposes no method that maps a
// historical record through live enablement, which is what makes that invariant
// mechanical rather than a convention (see the
// history-never-consults-live-registration contract test).
//
// Electron-free (execution-guidance rule 4): pure in-memory state. Persisting
// the enable/disable set + plugin storage to `electron-store` is host wiring that
// lands with the Settings plugin-list UI (P3).
import type {
  PluginCapabilityDecl,
  PluginContributions,
  PluginFollowUpDecl,
  PluginPermissionDecl,
  PluginUiContribution,
  PluginPromptBlock,
  RegisteredPlugin,
} from './plugin-manifest.ts'
import type { AsyncHook, BlockingHook } from '../hooks/canonical-events.ts'

/** A plugin and its current enablement, for the Settings plugin list (P3). */
export interface PluginGrouping {
  readonly plugin: RegisteredPlugin
  readonly enabled: boolean
}

/**
 * Namespaced, disable-surviving storage for one plugin (decision 17). A thin view
 * over the registry's per-plugin bag; the concrete persistence backend is injected
 * host-side in P3. `get` returns `unknown` — the registry never inspects the
 * value, so the caller narrows it rather than the registry casting on its behalf.
 */
export interface PluginStorage {
  get(key: string): unknown
  set(key: string, value: unknown): void
  has(key: string): boolean
  keys(): readonly string[]
}

/** Thrown when a lifecycle call names a plugin that was never registered. */
export class UnknownPluginError extends Error {
  readonly pluginId: string
  constructor(pluginId: string) {
    super(`no plugin registered with id "${pluginId}"`)
    this.name = 'UnknownPluginError'
    this.pluginId = pluginId
  }
}

/** Thrown when two plugins register under the same id (grouping must be unique). */
export class DuplicatePluginError extends Error {
  readonly pluginId: string
  constructor(pluginId: string) {
    super(`a plugin with id "${pluginId}" is already registered`)
    this.name = 'DuplicatePluginError'
    this.pluginId = pluginId
  }
}

/**
 * Thrown when a plugin registers a level-2 UI contribution without a `panel` decl.
 * The invariant is mechanical (rather than "please remember to add one"): a
 * level-2 contribution *is* a declarative panel, so the shape must be pinned at
 * registration or the host has nothing to validate incoming `panel_update`
 * payloads against (P2).
 */
export class InvalidPanelContributionError extends Error {
  readonly pluginId: string
  readonly contributionId: string
  constructor(pluginId: string, contributionId: string, reason: string) {
    super(`plugin "${pluginId}" contribution "${contributionId}" is invalid: ${reason}`)
    this.name = 'InvalidPanelContributionError'
    this.pluginId = pluginId
    this.contributionId = contributionId
  }
}

/**
 * Thrown when a plugin's follow-up bubble could not do what it declares. A
 * prompt bubble with nothing to send is a dead click, and a host action is a
 * first-party privilege that a user plugin must not self-grant through a
 * manifest field.
 */
export class InvalidFollowUpContributionError extends Error {
  readonly pluginId: string
  readonly followUpId: string
  constructor(pluginId: string, followUpId: string, reason: string) {
    super(`plugin "${pluginId}" follow-up "${followUpId}" is invalid: ${reason}`)
    this.name = 'InvalidFollowUpContributionError'
    this.pluginId = pluginId
    this.followUpId = followUpId
  }
}

/** Thrown when a plugin's ACP bridge declaration could expose an unsafe tool. */
export class InvalidAcpToolsError extends Error {
  readonly pluginId: string
  readonly toolName: string
  constructor(pluginId: string, toolName: string, reason: string) {
    super(`plugin "${pluginId}" ACP tool "${toolName}" is invalid: ${reason}`)
    this.name = 'InvalidAcpToolsError'
    this.pluginId = pluginId
    this.toolName = toolName
  }
}

export class PluginRegistry {
  // Insertion-ordered so `all()` / the active getters keep a deterministic
  // order (contribution order can be load-bearing, e.g. prompt assembly).
  private readonly plugins = new Map<string, RegisteredPlugin>()
  // Disabled ids. A plugin is enabled unless present here — so registering a plugin
  // enables it by default, matching VS Code's built-in-extension model.
  private readonly disabledIds = new Set<string>()
  // Per-plugin storage bag, keyed by plugin id. Never cleared on disable (decision
  // 17): the entry outlives the plugin's active registration.
  private readonly storageByPlugin = new Map<string, Map<string, unknown>>()

  /** Register a plugin, grouped by its id. Enabled by default. Duplicate id throws. */
  register(plugin: RegisteredPlugin): void {
    if (this.plugins.has(plugin.id)) throw new DuplicatePluginError(plugin.id)
    const acpTools = plugin.manifest.tools?.acpTools ?? []
    const nativeTools = new Set(plugin.manifest.tools?.native ?? [])
    const runtimeTools = new Set(plugin.contributions.toolNames)
    for (const toolName of acpTools) {
      if (plugin.trust !== 'first-party') {
        throw new InvalidAcpToolsError(
          plugin.id,
          toolName,
          'only first-party plugins may expose native tools to external ACP agents',
        )
      }
      if (!nativeTools.has(toolName)) {
        throw new InvalidAcpToolsError(
          plugin.id,
          toolName,
          '`tools.acpTools` must be a subset of `tools.native`',
        )
      }
      if (!runtimeTools.has(toolName)) {
        throw new InvalidAcpToolsError(
          plugin.id,
          toolName,
          'the tool must have a matching executable runtime contribution',
        )
      }
    }
    for (const contribution of plugin.contributions.uiContributions) {
      if (contribution.level === 2 && !contribution.panel) {
        throw new InvalidPanelContributionError(
          plugin.id,
          contribution.id,
          'level 2 (declarative panel) requires a `panel` decl (kind: list | tree)',
        )
      }
      // The inverse is equally mechanical: a `panel` decl on a level-1 card or a
      // level-3 real view is meaningless — reject it so a typo'd level never
      // ships a panel the host will silently ignore.
      if (contribution.level !== 2 && contribution.panel) {
        throw new InvalidPanelContributionError(
          plugin.id,
          contribution.id,
          `level ${String(contribution.level)} must not declare a \`panel\` — panels are the level-2 contract`,
        )
      }
    }
    for (const followUp of plugin.contributions.followUps) {
      const action = followUp.action ?? 'prompt'
      if (action !== 'prompt' && plugin.trust !== 'first-party') {
        throw new InvalidFollowUpContributionError(
          plugin.id,
          followUp.id,
          'only first-party plugins may bind a bubble to a host action — a user plugin may suggest a prompt',
        )
      }
      if (action === 'prompt' && !followUp.prompt?.trim()) {
        throw new InvalidFollowUpContributionError(
          plugin.id,
          followUp.id,
          'a `prompt` follow-up must carry the prompt text its click sends',
        )
      }
    }
    this.plugins.set(plugin.id, plugin)
  }

  /** Every registered plugin in registration order (Settings enumeration, P3). */
  all(): readonly RegisteredPlugin[] {
    return [...this.plugins.values()]
  }

  get(id: string): RegisteredPlugin | undefined {
    return this.plugins.get(id)
  }

  has(id: string): boolean {
    return this.plugins.has(id)
  }

  /**
   * Remove a dynamically discovered plugin from new work while retaining its
   * namespaced storage bag. First-party plugins are static and never call this;
   * local/user discovery uses it when a source disappears or its hash changes.
   */
  unregister(id: string): void {
    if (!this.plugins.has(id)) throw new UnknownPluginError(id)
    this.plugins.delete(id)
    this.disabledIds.delete(id)
  }

  /** True when the plugin is registered and not disabled. */
  isEnabled(id: string): boolean {
    return this.plugins.has(id) && !this.disabledIds.has(id)
  }

  /**
   * Enable a registered plugin (a no-op when already enabled). Its contributions
   * re-enter the active set for new work immediately; its persisted storage —
   * which was never cleared — is unchanged.
   */
  enable(id: string): void {
    if (!this.plugins.has(id)) throw new UnknownPluginError(id)
    this.disabledIds.delete(id)
  }

  /**
   * Disable a registered plugin **atomically**: a single flag flip drops every one
   * of its contribution kinds from the active getters at once (tools, hooks,
   * prompt blocks, UI). There is no partial state — the active set is recomputed
   * from `disabledIds`, so it can never show a plugin's tools without its hooks.
   * Storage is deliberately untouched (decision 17).
   */
  disable(id: string): void {
    if (!this.plugins.has(id)) throw new UnknownPluginError(id)
    this.disabledIds.add(id)
  }

  private enabledPlugins(): RegisteredPlugin[] {
    return this.all().filter((plugin) => !this.disabledIds.has(plugin.id))
  }

  private collectActive<T>(select: (c: PluginContributions) => readonly T[]): readonly T[] {
    const out: T[] = []
    for (const plugin of this.enabledPlugins()) out.push(...select(plugin.contributions))
    return out
  }

  /** Native tool names offered to the model right now (enabled plugins only). */
  activeToolNames(): readonly string[] {
    return this.collectActive((c) => c.toolNames)
  }

  /** Native plugin tools safe to offer to external ACP agents right now. */
  activeAcpToolNames(): readonly string[] {
    const out: string[] = []
    for (const plugin of this.enabledPlugins()) out.push(...(plugin.manifest.tools?.acpTools ?? []))
    return out
  }

  /** Thread-model routes paired with their owning enabled plugin. */
  activeModelRoutes(): readonly {
    readonly pluginId: string
    readonly route: RegisteredPlugin['contributions']['modelRoutes'][number]
  }[] {
    const out: Array<{
      pluginId: string
      route: RegisteredPlugin['contributions']['modelRoutes'][number]
    }> = []
    for (const plugin of this.enabledPlugins()) {
      for (const route of plugin.contributions.modelRoutes) out.push({ pluginId: plugin.id, route })
    }
    return out
  }

  /** Interactive browser origins paired with their owning enabled plugin. */
  activeBrowserOrigins(): readonly { readonly pluginId: string; readonly origin: string }[] {
    const out: Array<{ pluginId: string; origin: string }> = []
    for (const plugin of this.enabledPlugins()) {
      for (const origin of plugin.contributions.browserOrigins)
        out.push({ pluginId: plugin.id, origin })
    }
    return out
  }

  /** Blocking function hooks to register for new work (enabled plugins only). */
  activeBlockingHooks(): readonly BlockingHook[] {
    return this.collectActive((c) => c.blockingHooks)
  }

  /** Async (detached) function hooks to register for new work (enabled plugins only). */
  activeAsyncHooks(): readonly AsyncHook[] {
    return this.collectActive((c) => c.asyncHooks)
  }

  /** Prompt / steering blocks folded into assembly right now (enabled plugins only). */
  activePromptBlocks(): readonly PluginPromptBlock[] {
    return this.collectActive((c) => c.promptBlocks)
  }

  /** UI contributions that mount for new content right now (enabled plugins only). */
  activeUiContributions(): readonly PluginUiContribution[] {
    return this.collectActive((c) => c.uiContributions)
  }

  /**
   * Follow-up bubbles offered right now, each paired with its owning enabled
   * plugin. The host still filters on each declaration's `when` condition.
   */
  activeFollowUps(): readonly {
    readonly pluginId: string
    readonly followUp: PluginFollowUpDecl
  }[] {
    const out: { pluginId: string; followUp: PluginFollowUpDecl }[] = []
    for (const plugin of this.enabledPlugins()) {
      for (const followUp of plugin.contributions.followUps) {
        out.push({ pluginId: plugin.id, followUp })
      }
    }
    return out
  }

  /**
   * Capability flags active right now — every capability declared by an enabled
   * plugin (enabled plugins only). Disabling the owning plugin drops its capabilities
   * from this getter in the same atomic flag flip that drops its tools/hooks
   * (decision 15).
   */
  activeCapabilities(): readonly PluginCapabilityDecl[] {
    return this.collectActive((c) => c.capabilities)
  }

  /**
   * Whether a named capability is active — the single seam main and renderer
   * consult instead of a scattered standalone `getSetting` read. A capability is
   * active iff some *enabled* plugin declares it, so disabling that plugin turns the
   * behaviour off atomically.
   */
  isCapabilityActive(name: string): boolean {
    return this.activeCapabilities().some((capability) => capability.name === name)
  }

  /**
   * Permission / sandbox relaxations declared right now — every relaxation a
   * still-enabled plugin contributes (enabled plugins only). Disabling the owning
   * plugin drops its relaxations from this getter in the same atomic flag flip
   * that drops its tools/hooks (issue #1190), so the permission-gate stops
   * honouring the declared authority the moment the plugin is off.
   */
  activePermissions(): readonly PluginPermissionDecl[] {
    return this.collectActive((c) => c.permissions)
  }

  /**
   * Whether a named permission / sandbox relaxation is declared by an enabled
   * plugin — the seam the permission-gate consults before offering or honouring a
   * declared relaxation (issue #1190). A relaxation is grantable iff some
   * *enabled* plugin declares it, so disabling that plugin revokes the authority
   * atomically (mirrors {@link isCapabilityActive}).
   */
  isPermissionDeclared(name: string): boolean {
    return this.activePermissions().some((permission) => permission.name === name)
  }

  /**
   * Active level-2 declarative panels, each paired with its owning plugin id (P2).
   * The host mounts one generic list/tree component per entry into the named
   * `slot`; disabling the owning plugin drops it from this getter in one action,
   * so panels for new content stop mounting alongside the plugin's other
   * contribution kinds (decision 15 atomicity). Historical content is
   * unaffected — history renders from spine data, never the registry
   * (decision 17).
   */
  activePanelContributions(): readonly {
    readonly pluginId: string
    readonly contribution: PluginUiContribution
  }[] {
    const out: { pluginId: string; contribution: PluginUiContribution }[] = []
    for (const plugin of this.enabledPlugins()) {
      for (const contribution of plugin.contributions.uiContributions) {
        if (contribution.level === 2 && contribution.panel) {
          out.push({ pluginId: plugin.id, contribution })
        }
      }
    }
    return out
  }

  /** Every plugin + its enablement, for the Settings plugin list (P3). */
  grouping(): readonly PluginGrouping[] {
    return this.all().map((plugin) => ({ plugin, enabled: this.isEnabled(plugin.id) }))
  }

  /**
   * Namespaced storage for a plugin. The bag is created lazily and never cleared
   * on disable (decision 17), so a disabled plugin's data is intact when it is
   * re-enabled. Throws for an unknown plugin so a typo can't silently write into a
   * detached bag.
   */
  storage(id: string): PluginStorage {
    if (!this.plugins.has(id)) throw new UnknownPluginError(id)
    let bag = this.storageByPlugin.get(id)
    if (!bag) {
      bag = new Map<string, unknown>()
      this.storageByPlugin.set(id, bag)
    }
    const store = bag
    return {
      get(key: string): unknown {
        return store.get(key)
      },
      set(key: string, value: unknown): void {
        store.set(key, value)
      },
      has(key: string): boolean {
        return store.has(key)
      },
      keys(): readonly string[] {
        return [...store.keys()]
      },
    }
  }
}
