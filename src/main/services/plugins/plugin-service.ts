// Plugin service — P3 of docs/plans/hooks-and-feature-packs.md.
//
// The host wiring for the feature-plugin layer:
//  - owns the **shared** `PluginRegistry` (first-party plugins registered), and
//    installs it via `setDefaultPluginRegistry` so `createHookRegistry` (called
//    every turn) reads through the same instance the Settings UI toggles;
//  - applies the persisted disable set from `electron-store` before wiring the
//    provider, so a plugin the user turned off stays off across relaunches;
//  - persists plugin-scoped settings values under a namespaced storage key so
//    the manifest's declarative `settings` schema round-trips through Settings
//    generically (P3's "the about:addons of Copse");
//  - exposes `list()` / `setEnabled()` / `getSetting()` / `setSetting()` for
//    the `plugins:*` IPC handlers.
//
// **Atomic enable/disable (P1 contract).** `setEnabled` flips a single flag on
// the shared registry — every one of the plugin's contribution kinds drops from
// the active getters at once (tools, hooks, prompt blocks, panels). There is
// no partial state; persistence is a write-behind snapshot of `registry`.
//
// Storage layout under the shared `electron-store`:
//   `pluginDisabled`             → readonly string[]   (plugin ids the user disabled)
//   `plugin.<pluginId>.settings` → Record<string, unknown> (values keyed by field id)
//
// Renamed from `packDisabled` / `pack.<id>.settings` in C3 of
// docs/plans/agent-plugins-migration.md. `migratePackKeysToPlugin()` copies
// every old key forward on first boot and leaves the originals in place for one
// release; see its comment for why the copy is guarded by the destination key
// rather than a migration flag.
//
// The disable list stays a plain array (like `mcpDisabledServers`) so it is
// still readable / editable by hand and easy to migrate. Plugin settings are
// bagged per plugin to keep the top-level key namespace clean and let the P4
// todos plugin lift/shift its config into a single record.
import type { PluginRegistry } from '@copse/agent/plugins/plugin-registry.ts'
import {
  createFirstPartyPluginRegistry,
  EXPERIMENTAL_FIRST_PARTY_PLUGIN_IDS,
} from '@copse/agent/plugins/first-party-plugins.ts'
import { setDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { summarizePlugins, type PluginSummaryOut } from '@copse/agent/plugins/plugin-summary.ts'
import {
  MODEL_COMPARISON_PLUGIN_ID,
  COMPARISON_MODEL_A_SETTING_ID,
  COMPARISON_MODEL_B_SETTING_ID,
  COMPARISON_JUDGE_MODEL_SETTING_ID,
} from '@copse/agent/plugins/model-comparison-plugin.ts'
import {
  ADVISOR_STRATEGY_PLUGIN_ID,
  ADVISOR_MODEL_SETTING_ID,
} from '@copse/agent/plugins/advisor-strategy-plugin.ts'
import { AUTOMATIONS_PLUGIN_ID } from '@copse/agent/plugins/automations-plugin.ts'
import { PARALLEL_SEARCH_PLUGIN_ID } from '@copse/agent/plugins/parallel-search-plugin.ts'
import { storageGet, storageListKeys, storageSet, storageUpdate } from '../storage/storage.ts'
import { getSetting } from '../storage/settings.ts'
import { parseStringList } from '../storage/storage-schema.ts'
import {
  discoverPluginToolSource,
  registeredPluginToolSource,
  type PluginToolSourceCandidate,
} from './plugin-tool-source.ts'
import {
  discoverUserPlugins,
  registeredUserPlugin,
  type UserPluginCandidate,
} from './discover-user-plugins.ts'
import {
  getPluginToolRuntimeController,
  setPluginToolRuntimeController,
} from './plugin-tool-controller.ts'
import { setPluginBrowserService } from './plugin-browser-service.ts'
import type { DeclaredMcpServer } from '@shared/types/mcp.ts'

// P1 of #1336: selected-plugin discovery is part of the production graph before
// the isolated behavior runtime is wired by the host.
export { discoverPluginToolSource, hashPluginToolSource } from './plugin-tool-source.ts'

/** One-time bridge from the retired top-level model settings now owned by plugins. */
const PLUGIN_MODEL_SETTINGS_MIGRATION_KEY = 'pluginMigration.pluginModelSettings'

/** Storage key holding the ids of plugins the user disabled. */
const PLUGIN_DISABLED_KEY = 'pluginDisabled'

/** Explicitly user-selected plugin directories (#1336 P1). */
const PLUGIN_SOURCES_KEY = 'pluginSources'

/**
 * Ids of discovered Agent Plugins packages this profile has already seen.
 *
 * Purely a "have we met" record, so a plugin appearing in the plugin root can be
 * seeded off exactly once and never re-seeded afterwards. Without it, an id
 * missing from `pluginDisabled` is ambiguous — it means both "the user enabled
 * this" and "this is brand new".
 */
const PLUGINS_SEEN_KEY = 'pluginsSeen'

/**
 * Plugins that ship registered but off.
 *
 * `createFirstPartyPluginRegistry()` seeds every plugin enabled. The off-by-default
 * set is derived from each first-party manifest's `experimental` stability and
 * written into `pluginDisabled` on a profile that has never had one. This makes a
 * forgotten rollout-list update impossible when a new experiment is added.
 *
 * The three plugins added with the contribution kinds (#1188-#1190) join the list
 * for the same reason — each replaces a retired opt-in boolean
 * (`mcpUiArtefactsEnabled`, `devtoolsShortcutEnabled`, `backgroundTasksEnabled`).
 * `copse.background-tasks` matters most: beyond registering `run_background` it
 * declares the `loopback-bind` sandbox relaxation, so defaulting it on would
 * advertise an authority nobody asked for.
 *
 * `copse.forced-planning` never had a standalone setting to be opt-in through,
 * but belongs here for the same reason: it rewrites the system prompt of every
 * turn that runs on a below-threshold model.
 */
const DEFAULT_DISABLED_PLUGIN_IDS: readonly string[] = EXPERIMENTAL_FIRST_PARTY_PLUGIN_IDS

/** One-time default-off seed for the new local automations prototype. */
const AUTOMATIONS_ENABLEMENT_MIGRATION_KEY = 'pluginMigration.automationsEnablement'

/** One-time default-off seed for the hosted Parallel Search integration. */
const PARALLEL_SEARCH_ENABLEMENT_MIGRATION_KEY = 'pluginMigration.parallelSearchEnablement'

/** Storage key holding one plugin's settings values (`pluginId` scoped). */
function pluginSettingsKey(pluginId: string): string {
  return `plugin.${pluginId}.settings`
}

/**
 * Narrow a persisted `unknown` to a plain object bag. A type predicate rather
 * than an `as` cast: these values come off disk and may be any shape, so the
 * check has to be real (and `no-unsafe-type-assertion` agrees).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Carry every `pack*` storage key forward to its `plugin*` name (C3).
 *
 * **This is user data, and getting it wrong is silent.** `packDisabled` holds
 * the plugins someone deliberately switched off — and, just as importantly, the
 * *absence* of an id from it is how "I turned this experiment on" is recorded.
 * If the new key simply started life empty, every one of those choices would
 * revert on the upgrade that renamed them, and nothing would report it.
 *
 * Copy-if-absent rather than a one-shot guarded by its own flag: a flag can be
 * written when the copy half-failed, and there is no second chance. Here the
 * presence of the destination key *is* the guard, so a partial run resumes and
 * a completed one is a no-op.
 *
 * An **empty array is a value, not a blank.** `[]` means "everything on", which
 * is the opposite of "never configured", so the copy is keyed on `undefined`
 * and never on emptiness. The old keys are left in place for one release, so a
 * user who downgrades still finds their settings.
 */
function migratePackKeysToPlugin(): void {
  const copyIfAbsent = (from: string, to: string): void => {
    if (storageGet(to) !== undefined) return
    const previous = storageGet(from)
    if (previous === undefined) return
    storageSet(to, previous)
  }

  copyIfAbsent('packDisabled', PLUGIN_DISABLED_KEY)
  copyIfAbsent('packSources', PLUGIN_SOURCES_KEY)
  copyIfAbsent('packMigration.packModelSettings', PLUGIN_MODEL_SETTINGS_MIGRATION_KEY)
  copyIfAbsent('packMigration.automationsEnablement', AUTOMATIONS_ENABLEMENT_MIGRATION_KEY)
  copyIfAbsent('packMigration.parallelSearchEnablement', PARALLEL_SEARCH_ENABLEMENT_MIGRATION_KEY)

  // Per-plugin bags — `pack.<id>.settings`, `.threadSessions`, `.storage`. The
  // id is opaque and may itself contain dots (`copse.todos`), so this rewrites
  // the prefix rather than parsing the key into parts.
  for (const key of storageListKeys()) {
    if (!key.startsWith('pack.')) continue
    copyIfAbsent(key, `plugin.${key.slice('pack.'.length)}`)
  }
}

/** Read the persisted disable set. */
function readDisabledIds(): Set<string> {
  return new Set(parseStringList(storageGet(PLUGIN_DISABLED_KEY)))
}

/** Ids of discovered plugins this profile has already seeded an answer for. */
function knownPluginIds(): Set<string> {
  return new Set(parseStringList(storageGet(PLUGINS_SEEN_KEY)))
}

/**
 * Write the default-off set, but only on a profile that has no `pluginDisabled`
 * list at all. Once the key exists it is the user's own — including an empty
 * list, which means "everything on" — and is never re-seeded, so a plugin enabled
 * in Settings stays enabled across relaunches.
 *
 * Runs synchronously before the shared registry is created: `createRegistry()`
 * consults it immediately to decide whether `compare_models` belongs in the
 * model's tool list, and `pii-redactor.ts` to decide whether to rewrite input.
 */
function seedDefaultDisabledPlugins(): void {
  if (storageGet(PLUGIN_DISABLED_KEY) !== undefined) return
  storageSet(PLUGIN_DISABLED_KEY, [...DEFAULT_DISABLED_PLUGIN_IDS].sort())
}

/**
 * Automations have no retired standalone toggle to migrate. Seed the new plugin
 * disabled exactly once so an upgrade never starts a clock-driven feature
 * without an explicit opt-in; subsequent user toggles own the disable set.
 */
function migrateAutomationsEnablement(): void {
  if (storageGet(AUTOMATIONS_ENABLEMENT_MIGRATION_KEY) === true) return
  const disabled = readDisabledIds()
  disabled.add(AUTOMATIONS_PLUGIN_ID)
  storageSet(PLUGIN_DISABLED_KEY, [...disabled].sort())
  storageSet(AUTOMATIONS_ENABLEMENT_MIGRATION_KEY, true)
}

/**
 * Parallel Search sends user queries to a paid external API. Existing profiles
 * already own `pluginDisabled`, so seed this newly introduced plugin off exactly
 * once instead of accidentally enabling network access on upgrade.
 */
function migrateParallelSearchEnablement(): void {
  if (storageGet(PARALLEL_SEARCH_ENABLEMENT_MIGRATION_KEY) === true) return
  const disabled = readDisabledIds()
  disabled.add(PARALLEL_SEARCH_PLUGIN_ID)
  storageSet(PLUGIN_DISABLED_KEY, [...disabled].sort())
  storageSet(PARALLEL_SEARCH_ENABLEMENT_MIGRATION_KEY, true)
}

/** Read one plugin's persisted settings bag (`{}` when nothing stored). */
function readPluginSettings(pluginId: string): Record<string, unknown> {
  const raw = storageGet(pluginSettingsKey(pluginId))
  return isRecord(raw) ? raw : {}
}

/**
 * Read one plugin-scoped setting value directly from storage, without constructing
 * (or booting) the plugin service. Exposed so host read sites that previously read
 * a top-level model setting — `advisor-runner.ts`, `model-comparison-runner.ts` —
 * can read the plugin-owned value with no init-order coupling. Returns the raw
 * persisted value (the caller coerces/trims); `undefined` when unset.
 */
export function readPluginSettingValue(pluginId: string, key: string): unknown {
  return readPluginSettings(pluginId)[key]
}

/**
 * Preserve the model choices users had before `advisorModel` /
 * `comparisonModelA` / `comparisonModelB` / `comparisonJudgeModel` moved from
 * top-level **settings.json** keys onto their plugins' `model` setting fields
 * (under `config.json` `plugin.<id>.settings`). Copies any existing top-level
 * value into the owning plugin's settings bag (without clobbering a value already
 * written there), so the Settings → Plugins picker and the runtime read sites
 * agree and no user loses their configured models on upgrade.
 *
 * Reads via `getSetting` (settings store), not `storageGet` (config store) —
 * these model ids always lived in `settings.json` alongside `model`. Idempotent
 * (guarded by its own migration key); a role assignment in `roleModels` still
 * takes precedence at read time and is left untouched.
 */
function migratePluginModelSettings(): void {
  if (storageGet(PLUGIN_MODEL_SETTINGS_MIGRATION_KEY) === true) return

  const moves: Array<{ pluginId: string; key: string; legacyKey: string }> = [
    {
      pluginId: ADVISOR_STRATEGY_PLUGIN_ID,
      key: ADVISOR_MODEL_SETTING_ID,
      legacyKey: 'advisorModel',
    },
    {
      pluginId: MODEL_COMPARISON_PLUGIN_ID,
      key: COMPARISON_MODEL_A_SETTING_ID,
      legacyKey: 'comparisonModelA',
    },
    {
      pluginId: MODEL_COMPARISON_PLUGIN_ID,
      key: COMPARISON_MODEL_B_SETTING_ID,
      legacyKey: 'comparisonModelB',
    },
    {
      pluginId: MODEL_COMPARISON_PLUGIN_ID,
      key: COMPARISON_JUDGE_MODEL_SETTING_ID,
      legacyKey: 'comparisonJudgeModel',
    },
  ]

  const bags = new Map<string, Record<string, unknown>>()
  const bagFor = (pluginId: string): Record<string, unknown> => {
    let bag = bags.get(pluginId)
    if (!bag) {
      bag = { ...readPluginSettings(pluginId) }
      bags.set(pluginId, bag)
    }
    return bag
  }

  for (const move of moves) {
    const legacy = getSetting(move.legacyKey, '')
    if (typeof legacy !== 'string' || legacy.trim() === '') continue
    const bag = bagFor(move.pluginId)
    if (bag[move.key] === undefined) bag[move.key] = legacy
  }

  for (const [pluginId, bag] of bags) storageSet(pluginSettingsKey(pluginId), bag)
  storageSet(PLUGIN_MODEL_SETTINGS_MIGRATION_KEY, true)
}

/**
 * The singleton plugin service. Constructed lazily on first `getPluginService()` so
 * host boot order (electron-store availability) is respected without an
 * explicit init call, and unit tests can create their own via `createPluginService`.
 */
let singleton: PluginService | null = null

/** Public shape: what the IPC handlers + tests actually use. */
export interface PluginService {
  /** The shared registry, exposed so callers that need typed contributions can read it. */
  readonly registry: PluginRegistry
  /** Snapshot every plugin for the Settings plugin list. */
  list(): readonly PluginSummaryOut[]
  /**
   * Toggle a plugin's enablement. Persists the change to `electron-store` and
   * flips the flag on the shared registry — atomic, per the P1 contract.
   */
  setEnabled(pluginId: string, enabled: boolean): Promise<void>
  /** Read one plugin-scoped setting value (raw persisted value; renderer coerces). */
  getSetting(pluginId: string, key: string): unknown
  /** Persist one plugin-scoped setting value under the plugin's namespaced bag. */
  setSetting(pluginId: string, key: string, value: unknown): Promise<void>
  /** Reconcile explicitly selected plugin sources into the registry. */
  refreshPluginSources(): Promise<void>
  /**
   * Discover Agent Plugins packages under the Copse-owned plugin root and give
   * each a registry row. Stage A2 of `docs/plans/agent-plugins-migration.md`.
   */
  refreshUserPlugins(): Promise<void>
  /**
   * MCP servers discovered plugins declare that nothing is running, so
   * Settings → MCP servers can account for them. See {@link DeclaredMcpServer}.
   */
  declaredMcpServers(): readonly DeclaredMcpServer[]
  /** Persist and discover one directory selected through the host-owned native dialog. */
  addPluginSource(sourcePath: string): Promise<void>
}

/**
 * Build a plugin service backed by the given registry. The persisted disable set
 * is applied before returning, so subsequent `getDefaultPluginRegistry()` /
 * `createHookRegistry()` calls see the same enablement the Settings list will
 * show. Exposed for tests; production callers go through `getPluginService`.
 */
/**
 * Why a selected plugin ended up unusable, keyed by plugin id — and, for sources
 * that never yielded a plugin at all, keyed by source path.
 *
 * `refreshPluginSources` is the only place that sees the real cause: the runtime
 * threw, or the source would not load. Until now it went solely to a
 * `console.warn`, which in CI lives inside a failure artifact. Anything
 * downstream could therefore report the resulting *state* ("is disabled") but
 * never the reason, so diagnosing a plugin that would not start meant fetching
 * that artifact by hand. Holding the reason here lets the error a caller
 * already throws carry it.
 *
 * Module-scoped to match `getDefaultPluginRegistry()` — read sites reach for it
 * the same way they reach for the registry, without threading a service
 * instance through.
 */
const pluginUnavailableReasons = new Map<string, string>()
const inertSourceReasons = new Map<string, string>()

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Why this plugin is not usable, when {@link refreshPluginSources} recorded a cause. */
export function pluginUnavailableReason(pluginId: string): string | undefined {
  return pluginUnavailableReasons.get(pluginId)
}

/**
 * Sources that failed discovery, as `path: reason`. A plugin missing from the
 * registry entirely is usually explained by one of these rather than by
 * anything keyed on its id — discovery never got far enough to learn the id.
 */
export function inertPluginSources(): readonly string[] {
  return [...inertSourceReasons].map(([source, reason]) => `${source}: ${reason}`)
}

export function createPluginService(registry: PluginRegistry): PluginService {
  const disabled = readDisabledIds()
  const selectedCandidates = new Map<string, PluginToolSourceCandidate>()
  const userPlugins = new Map<string, UserPluginCandidate>()
  for (const id of disabled) {
    if (registry.has(id)) registry.disable(id)
  }

  /**
   * Reconcile the Agent Plugins packages on disk into the registry.
   *
   * Registration is deliberately all a discovered plugin gets: a Settings row
   * and the atomic enable/disable lifecycle. Its command hooks and MCP servers
   * are not wired into the live agent loop here, because finding bytes must not
   * be what activates behavior (#1082 follow-up).
   *
   * A plugin whose directory disappeared is unregistered, mirroring the
   * selected-source reconciliation above. Its persisted settings and disable
   * state survive — like a disabled browser extension's data (decision 17).
   */
  async function refreshUserPlugins(): Promise<void> {
    const discovery = await discoverUserPlugins()
    for (const failure of discovery.failures) {
      inertSourceReasons.set(failure.pluginRoot, failure.reason)
      console.warn(`[plugins] ${failure.pluginRoot} is inert: ${failure.reason}`)
    }

    const found = new Map(discovery.plugins.map((plugin) => [plugin.manifest.name, plugin]))
    for (const [id, previous] of userPlugins) {
      const next = found.get(id)
      if (next && next.pluginRoot === previous.pluginRoot) continue
      registry.disable(id)
      registry.unregister(id)
      userPlugins.delete(id)
    }

    const fresh: string[] = []
    for (const candidate of discovery.plugins) {
      const id = candidate.manifest.name
      if (userPlugins.has(id)) continue
      if (registry.has(id)) {
        // A first-party or selected-directory plugin already owns this id.
        // Refusing here keeps the incumbent working rather than throwing.
        inertSourceReasons.set(
          candidate.pluginRoot,
          `plugin id ${JSON.stringify(id)} is already registered`,
        )
        console.warn(`[plugins] ${candidate.pluginRoot} conflicts with a registered plugin id.`)
        continue
      }
      for (const warning of candidate.warnings) {
        console.warn(`[plugins] ${id}: ${warning}`)
      }
      registry.register(registeredUserPlugin(candidate))
      userPlugins.set(id, candidate)
      if (!knownPluginIds().has(id)) fresh.push(id)
    }

    // A plugin seen for the first time is seeded **off**. `pluginDisabled` alone
    // cannot express this: an id absent from it means "enabled", which is
    // indistinguishable between a plugin the user switched on and one that
    // appeared on disk a moment ago. `pluginsSeen` is the missing record, so a
    // manifest arriving in the plugin root can never start contributing before
    // anyone looks at it — while a later toggle stays the user's own.
    if (fresh.length > 0) {
      await storageUpdate(PLUGINS_SEEN_KEY, (raw) => {
        const seen = new Set(parseStringList(raw))
        for (const id of fresh) seen.add(id)
        return [...seen].sort()
      })
      await storageUpdate(PLUGIN_DISABLED_KEY, (raw) => {
        const off = new Set(parseStringList(raw))
        for (const id of fresh) off.add(id)
        return [...off].sort()
      })
    }

    const off = readDisabledIds()
    for (const id of userPlugins.keys()) {
      if (off.has(id)) registry.disable(id)
      else registry.enable(id)
    }
  }

  /**
   * Every MCP server a discovered plugin declares, as an inert record.
   *
   * Discovery validates these entries and stops there — wiring them into the
   * live agent loop is separate work, and a disabled plugin's servers would not
   * run in any case. Both are states a user reading Settings → MCP servers
   * needs told about, because the alternative is a section that says "no
   * servers" while a package on disk names three. Nothing here is spawned:
   * reporting a declaration is not honouring it.
   */
  function declaredMcpServers(): readonly DeclaredMcpServer[] {
    const out: DeclaredMcpServer[] = []
    for (const [id, candidate] of userPlugins) {
      const enabled = registry.has(id) && registry.isEnabled(id)
      for (const [name, server] of candidate.mcpServers) {
        out.push({
          name,
          transport: server.type === 'stdio' ? 'stdio' : 'http',
          pluginId: id,
          pluginEnabled: enabled,
          reason: enabled
            ? 'Declared by an enabled plugin; Copse does not start plugin MCP servers yet.'
            : 'The plugin that declares it is turned off.',
        })
      }
    }
    return out.sort((a, b) => a.pluginId.localeCompare(b.pluginId) || a.name.localeCompare(b.name))
  }

  async function refreshPluginSources(): Promise<void> {
    const sources = parseStringList(storageGet(PLUGIN_SOURCES_KEY))
    const discovered: PluginToolSourceCandidate[] = []
    for (const source of sources) {
      try {
        discovered.push(await discoverPluginToolSource(source))
        inertSourceReasons.delete(source)
      } catch (error) {
        inertSourceReasons.set(source, describeError(error))
        console.warn(`[plugins] selected source ${JSON.stringify(source)} is inert:`, error)
      }
    }

    const controller = getPluginToolRuntimeController()
    const discoveredById = new Map(
      discovered.map((candidate) => [candidate.manifest.name, candidate]),
    )
    for (const [id, previous] of selectedCandidates) {
      const next = discoveredById.get(id)
      if (
        next &&
        next.sourcePath === previous.sourcePath &&
        next.contentHash === previous.contentHash
      ) {
        continue
      }
      registry.disable(id)
      if (controller?.isRunning(id)) await controller.disable(id)
      registry.unregister(id)
      selectedCandidates.delete(id)
    }

    for (const candidate of discovered) {
      const id = candidate.manifest.name
      const existing = selectedCandidates.get(id)
      if (!existing && registry.has(id)) {
        console.warn(
          `[plugins] selected plugin id ${JSON.stringify(id)} conflicts with a registered plugin.`,
        )
        continue
      }
      if (!existing) {
        registry.register(registeredPluginToolSource(candidate))
        selectedCandidates.set(id, candidate)
      }
      const current = selectedCandidates.get(id)
      if (!current) continue
      const shouldRun = !readDisabledIds().has(id)
      if (shouldRun && controller) {
        try {
          await controller.enable(current)
          registry.enable(id)
          pluginUnavailableReasons.delete(id)
        } catch (error) {
          registry.disable(id)
          // Note the cause before disabling loses it. This is the branch the
          // selected-plugin e2e lands in when the OS sandbox is unavailable:
          // plugin behavior fails closed, so the plugin is registered and then
          // switched off, which on its own is indistinguishable from a user
          // having turned it off.
          pluginUnavailableReasons.set(id, describeError(error))
          console.warn(`[plugins] plugin ${JSON.stringify(id)} tools could not start:`, error)
        }
      } else {
        registry.disable(id)
        pluginUnavailableReasons.set(id, 'disabled in Settings → Plugins')
        if (controller?.isRunning(id)) await controller.disable(id)
      }
    }
  }

  return {
    registry,
    list(): readonly PluginSummaryOut[] {
      return summarizePlugins(registry, (pluginId, key) => readPluginSettings(pluginId)[key]).map(
        (summary) => {
          const candidate = selectedCandidates.get(summary.id)
          if (!candidate) return summary
          return {
            ...summary,
            source: {
              kind: 'directory' as const,
              path: candidate.sourcePath,
              contentHash: candidate.contentHash,
            },
          }
        },
      )
    },
    async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
      if (!registry.has(pluginId)) return
      const selected = selectedCandidates.get(pluginId)
      if (selected) {
        if (!enabled) {
          registry.disable(pluginId)
          const controller = getPluginToolRuntimeController()
          if (controller?.isRunning(pluginId)) await controller.disable(pluginId)
          await storageUpdate(PLUGIN_DISABLED_KEY, (raw) => {
            const set = new Set(parseStringList(raw))
            set.add(pluginId)
            return [...set].sort()
          })
          return
        }
        const controller = getPluginToolRuntimeController()
        if (!controller) {
          throw new Error(`plugin "${pluginId}" runtime is unavailable`)
        }
        await controller.enable(selected)
        registry.enable(pluginId)
        await storageUpdate(PLUGIN_DISABLED_KEY, (raw) => {
          const set = new Set(parseStringList(raw))
          set.delete(pluginId)
          return [...set].sort()
        })
        return
      }
      if (enabled) registry.enable(pluginId)
      else registry.disable(pluginId)
      await storageUpdate(PLUGIN_DISABLED_KEY, (raw) => {
        const set = new Set(parseStringList(raw))
        if (enabled) set.delete(pluginId)
        else set.add(pluginId)
        return [...set].sort()
      })
    },
    getSetting(pluginId: string, key: string): unknown {
      return readPluginSettings(pluginId)[key]
    },
    async setSetting(pluginId: string, key: string, value: unknown): Promise<void> {
      // Only keys the plugin's manifest declares are persistable (P3 review): the
      // IPC caps value size, but without this any renderer bug (or compromise)
      // could grow arbitrary keys in any plugin's bag forever.
      const plugin = registry.has(pluginId) ? registry.get(pluginId) : undefined
      const declared = plugin?.manifest.settings
      if (!declared || !(key in declared)) {
        throw new Error(`plugin "${pluginId}" declares no setting "${key}"`)
      }
      await storageUpdate(pluginSettingsKey(pluginId), (raw) => {
        const current: Record<string, unknown> = isRecord(raw) ? { ...raw } : {}
        current[key] = value
        return current
      })
    },
    refreshPluginSources,
    refreshUserPlugins,
    declaredMcpServers,
    async addPluginSource(sourcePath: string): Promise<void> {
      const candidate = await discoverPluginToolSource(sourcePath)
      if (
        registry.has(candidate.manifest.name) &&
        !selectedCandidates.has(candidate.manifest.name)
      ) {
        throw new Error(`plugin id "${candidate.manifest.name}" is already registered`)
      }
      await storageUpdate(PLUGIN_SOURCES_KEY, (raw) => {
        const sources = new Set(parseStringList(raw))
        sources.add(candidate.sourcePath)
        return [...sources].sort()
      })
      await storageUpdate(PLUGIN_DISABLED_KEY, (raw) => {
        const ids = new Set(parseStringList(raw))
        ids.delete(candidate.manifest.name)
        return [...ids].sort()
      })
      await refreshPluginSources()
    },
  }
}

/**
 * Boot the process-wide plugin service and install its registry as the loop's
 * default. Safe to call multiple times — the second call returns the existing
 * singleton, which is exactly what the IPC handlers rely on.
 */
export function getPluginService(): PluginService {
  if (singleton) return singleton
  // Must run first. `seedDefaultDisabledPlugins` writes the default-off set on
  // any profile with no `pluginDisabled` key — so on the upgrade that renames
  // the keys, running it before the copy would overwrite the user's real
  // choices with the shipped defaults, and the old key would still be sitting
  // there unread.
  migratePackKeysToPlugin()
  seedDefaultDisabledPlugins()
  migratePluginModelSettings()
  migrateAutomationsEnablement()
  migrateParallelSearchEnablement()
  const registry = createFirstPartyPluginRegistry()
  const service = createPluginService(registry)
  setDefaultPluginRegistry(registry)
  singleton = service
  return service
}

/** Reset for tests. Not exported through the barrel; tests import it directly. */
export function __resetPluginServiceForTests(): void {
  singleton = null
  setDefaultPluginRegistry(null)
  setPluginToolRuntimeController(null)
  setPluginBrowserService(null)
}
