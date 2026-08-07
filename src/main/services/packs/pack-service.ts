// Pack service — P3 of docs/plans/hooks-and-feature-packs.md.
//
// The host wiring for the feature-pack layer:
//  - owns the **shared** `PackRegistry` (first-party packs registered), and
//    installs it via `setDefaultPackRegistry` so `createHookRegistry` (called
//    every turn) reads through the same instance the Settings UI toggles;
//  - applies the persisted disable set from `electron-store` before wiring the
//    provider, so a pack the user turned off stays off across relaunches;
//  - persists pack-scoped settings values under a namespaced storage key so
//    the manifest's declarative `settings` schema round-trips through Settings
//    generically (P3's "the about:addons of Copse");
//  - exposes `list()` / `setEnabled()` / `getSetting()` / `setSetting()` for
//    the `packs:*` IPC handlers.
//
// **Atomic enable/disable (P1 contract).** `setEnabled` flips a single flag on
// the shared registry — every one of the pack's contribution kinds drops from
// the active getters at once (tools, hooks, prompt blocks, panels). There is
// no partial state; persistence is a write-behind snapshot of `registry`.
//
// Storage layout under the shared `electron-store`:
//   `packDisabled`         → readonly string[]   (pack ids the user disabled)
//   `pack.<packId>.settings` → Record<string, unknown> (values keyed by field id)
//
// The disable list stays a plain array (like `mcpDisabledServers`) so it is
// still readable / editable by hand and easy to migrate. Pack settings are
// bagged per pack to keep the top-level key namespace clean and let the P4
// todos pack lift/shift its config into a single record.
import type { PackRegistry } from '@copse/agent/packs/pack-registry.ts'
import {
  createFirstPartyPackRegistry,
  EXPERIMENTAL_FIRST_PARTY_PACK_IDS,
} from '@copse/agent/packs/first-party-packs.ts'
import { setDefaultPackRegistry } from '@copse/agent/packs/default-pack-registry.ts'
import { summarizePacks, type PackSummaryOut } from '@copse/agent/packs/pack-summary.ts'
import {
  MODEL_COMPARISON_PACK_ID,
  COMPARISON_MODEL_A_SETTING_ID,
  COMPARISON_MODEL_B_SETTING_ID,
  COMPARISON_JUDGE_MODEL_SETTING_ID,
} from '@copse/agent/packs/model-comparison-pack.ts'
import {
  ADVISOR_STRATEGY_PACK_ID,
  ADVISOR_MODEL_SETTING_ID,
} from '@copse/agent/packs/advisor-strategy-pack.ts'
import { AUTOMATIONS_PACK_ID } from '@copse/agent/packs/automations-pack.ts'
import { BACKGROUND_TASKS_PACK_ID } from '@copse/agent/packs/background-tasks-pack.ts'
import { PARALLEL_SEARCH_PACK_ID } from '@copse/agent/packs/parallel-search-pack.ts'
import { storageGet, storageSet, storageUpdate } from '../storage/storage.ts'
import { getSetting } from '../storage/settings.ts'
import { parseStringList } from '../storage/storage-schema.ts'
import {
  discoverPackToolSource,
  registeredPackToolSource,
  type PackToolSourceCandidate,
} from './pack-tool-source.ts'
import {
  discoverUserPlugins,
  registeredUserPlugin,
  type UserPluginCandidate,
} from './discover-user-plugins.ts'
import {
  getPackToolRuntimeController,
  setPackToolRuntimeController,
} from './pack-tool-controller.ts'
import { setPackBrowserService } from './pack-browser-service.ts'

// P1 of #1336: selected-pack discovery is part of the production graph before
// the isolated behavior runtime is wired by the host.
export { discoverPackToolSource, hashPackToolSource } from './pack-tool-source.ts'

/** One-time bridge from the retired top-level model settings now owned by packs. */
const PACK_MODEL_SETTINGS_MIGRATION_KEY = 'packMigration.packModelSettings'

/** Storage key holding the ids of packs the user disabled. */
const PACK_DISABLED_KEY = 'packDisabled'

/** Explicitly user-selected pack directories (#1336 P1). */
const PACK_SOURCES_KEY = 'packSources'

/**
 * Ids of discovered Agent Plugins packages this profile has already seen.
 *
 * Purely a "have we met" record, so a plugin appearing in the plugin root can be
 * seeded off exactly once and never re-seeded afterwards. Without it, an id
 * missing from `packDisabled` is ambiguous — it means both "the user enabled
 * this" and "this is brand new".
 */
const PLUGINS_SEEN_KEY = 'pluginsSeen'

/**
 * Packs that ship registered but off.
 *
 * `createFirstPartyPackRegistry()` seeds every pack enabled. The off-by-default
 * set is derived from each first-party manifest's `experimental` stability and
 * written into `packDisabled` on a profile that has never had one. This makes a
 * forgotten rollout-list update impossible when a new experiment is added.
 *
 * The capability packs added in #1188 remain experimental because each replaces
 * a retired opt-in boolean (`mcpUiArtefactsEnabled`, `devtoolsShortcutEnabled`).
 * `copse.background-tasks` graduated to stable/default-on: its ordinary sandboxed
 * process support needs no extra authority, while `loopback-bind` still requires
 * a separate per-project grant at the point of use.
 *
 * `copse.forced-planning` never had a standalone setting to be opt-in through,
 * but belongs here for the same reason: it rewrites the system prompt of every
 * turn that runs on a below-threshold model.
 */
const DEFAULT_DISABLED_PACK_IDS: readonly string[] = EXPERIMENTAL_FIRST_PARTY_PACK_IDS

/** One-time graduation from opt-in experiment to stable/default-on primitive. */
const BACKGROUND_TASKS_STABLE_MIGRATION_KEY = 'packMigration.backgroundTasksStable'

/** One-time default-off seed for the new local automations prototype. */
const AUTOMATIONS_ENABLEMENT_MIGRATION_KEY = 'packMigration.automationsEnablement'

/** One-time default-off seed for the hosted Parallel Search integration. */
const PARALLEL_SEARCH_ENABLEMENT_MIGRATION_KEY = 'packMigration.parallelSearchEnablement'

/** Storage key holding one pack's settings values (`packId` scoped). */
function packSettingsKey(packId: string): string {
  return `pack.${packId}.settings`
}

/**
 * Narrow a persisted `unknown` to a plain object bag. A type predicate rather
 * than an `as` cast: these values come off disk and may be any shape, so the
 * check has to be real (and `no-unsafe-type-assertion` agrees).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read the persisted disable set. */
function readDisabledIds(): Set<string> {
  return new Set(parseStringList(storageGet(PACK_DISABLED_KEY)))
}

/** Ids of discovered plugins this profile has already seeded an answer for. */
function knownPluginIds(): Set<string> {
  return new Set(parseStringList(storageGet(PLUGINS_SEEN_KEY)))
}

/**
 * Write the default-off set, but only on a profile that has no `packDisabled`
 * list at all. Once the key exists it is the user's own — including an empty
 * list, which means "everything on" — and is never re-seeded, so a pack enabled
 * in Settings stays enabled across relaunches.
 *
 * Runs synchronously before the shared registry is created: `createRegistry()`
 * consults it immediately to decide whether `compare_models` belongs in the
 * model's tool list, and `pii-redactor.ts` to decide whether to rewrite input.
 */
function seedDefaultDisabledPacks(): void {
  if (storageGet(PACK_DISABLED_KEY) !== undefined) return
  storageSet(PACK_DISABLED_KEY, [...DEFAULT_DISABLED_PACK_IDS].sort())
}

/**
 * Graduate background tasks from experimental/default-off to stable/default-on.
 * Existing profiles cannot distinguish the old seeded disable from an explicit
 * experimental opt-out, so the graduation removes it once. Any disable made
 * after this migration remains user-owned because the marker prevents re-entry.
 */
function migrateBackgroundTasksStable(): void {
  if (storageGet(BACKGROUND_TASKS_STABLE_MIGRATION_KEY) === true) return
  const disabled = readDisabledIds()
  disabled.delete(BACKGROUND_TASKS_PACK_ID)
  storageSet(PACK_DISABLED_KEY, [...disabled].sort())
  storageSet(BACKGROUND_TASKS_STABLE_MIGRATION_KEY, true)
}

/**
 * Automations have no retired standalone toggle to migrate. Seed the new pack
 * disabled exactly once so an upgrade never starts a clock-driven feature
 * without an explicit opt-in; subsequent user toggles own the disable set.
 */
function migrateAutomationsEnablement(): void {
  if (storageGet(AUTOMATIONS_ENABLEMENT_MIGRATION_KEY) === true) return
  const disabled = readDisabledIds()
  disabled.add(AUTOMATIONS_PACK_ID)
  storageSet(PACK_DISABLED_KEY, [...disabled].sort())
  storageSet(AUTOMATIONS_ENABLEMENT_MIGRATION_KEY, true)
}

/**
 * Parallel Search sends user queries to a paid external API. Existing profiles
 * already own `packDisabled`, so seed this newly introduced pack off exactly
 * once instead of accidentally enabling network access on upgrade.
 */
function migrateParallelSearchEnablement(): void {
  if (storageGet(PARALLEL_SEARCH_ENABLEMENT_MIGRATION_KEY) === true) return
  const disabled = readDisabledIds()
  disabled.add(PARALLEL_SEARCH_PACK_ID)
  storageSet(PACK_DISABLED_KEY, [...disabled].sort())
  storageSet(PARALLEL_SEARCH_ENABLEMENT_MIGRATION_KEY, true)
}

/** Read one pack's persisted settings bag (`{}` when nothing stored). */
function readPackSettings(packId: string): Record<string, unknown> {
  const raw = storageGet(packSettingsKey(packId))
  return isRecord(raw) ? raw : {}
}

/**
 * Read one pack-scoped setting value directly from storage, without constructing
 * (or booting) the pack service. Exposed so host read sites that previously read
 * a top-level model setting — `advisor-runner.ts`, `model-comparison-runner.ts` —
 * can read the pack-owned value with no init-order coupling. Returns the raw
 * persisted value (the caller coerces/trims); `undefined` when unset.
 */
export function readPackSettingValue(packId: string, key: string): unknown {
  return readPackSettings(packId)[key]
}

/**
 * Preserve the model choices users had before `advisorModel` /
 * `comparisonModelA` / `comparisonModelB` / `comparisonJudgeModel` moved from
 * top-level **settings.json** keys onto their packs' `model` setting fields
 * (under `config.json` `pack.<id>.settings`). Copies any existing top-level
 * value into the owning pack's settings bag (without clobbering a value already
 * written there), so the Settings → Packs picker and the runtime read sites
 * agree and no user loses their configured models on upgrade.
 *
 * Reads via `getSetting` (settings store), not `storageGet` (config store) —
 * these model ids always lived in `settings.json` alongside `model`. Idempotent
 * (guarded by its own migration key); a role assignment in `roleModels` still
 * takes precedence at read time and is left untouched.
 */
function migratePackModelSettings(): void {
  if (storageGet(PACK_MODEL_SETTINGS_MIGRATION_KEY) === true) return

  const moves: Array<{ packId: string; key: string; legacyKey: string }> = [
    { packId: ADVISOR_STRATEGY_PACK_ID, key: ADVISOR_MODEL_SETTING_ID, legacyKey: 'advisorModel' },
    {
      packId: MODEL_COMPARISON_PACK_ID,
      key: COMPARISON_MODEL_A_SETTING_ID,
      legacyKey: 'comparisonModelA',
    },
    {
      packId: MODEL_COMPARISON_PACK_ID,
      key: COMPARISON_MODEL_B_SETTING_ID,
      legacyKey: 'comparisonModelB',
    },
    {
      packId: MODEL_COMPARISON_PACK_ID,
      key: COMPARISON_JUDGE_MODEL_SETTING_ID,
      legacyKey: 'comparisonJudgeModel',
    },
  ]

  const bags = new Map<string, Record<string, unknown>>()
  const bagFor = (packId: string): Record<string, unknown> => {
    let bag = bags.get(packId)
    if (!bag) {
      bag = { ...readPackSettings(packId) }
      bags.set(packId, bag)
    }
    return bag
  }

  for (const move of moves) {
    const legacy = getSetting(move.legacyKey, '')
    if (typeof legacy !== 'string' || legacy.trim() === '') continue
    const bag = bagFor(move.packId)
    if (bag[move.key] === undefined) bag[move.key] = legacy
  }

  for (const [packId, bag] of bags) storageSet(packSettingsKey(packId), bag)
  storageSet(PACK_MODEL_SETTINGS_MIGRATION_KEY, true)
}

/**
 * The singleton pack service. Constructed lazily on first `getPackService()` so
 * host boot order (electron-store availability) is respected without an
 * explicit init call, and unit tests can create their own via `createPackService`.
 */
let singleton: PackService | null = null

/** Public shape: what the IPC handlers + tests actually use. */
export interface PackService {
  /** The shared registry, exposed so callers that need typed contributions can read it. */
  readonly registry: PackRegistry
  /** Snapshot every pack for the Settings pack list. */
  list(): readonly PackSummaryOut[]
  /**
   * Toggle a pack's enablement. Persists the change to `electron-store` and
   * flips the flag on the shared registry — atomic, per the P1 contract.
   */
  setEnabled(packId: string, enabled: boolean): Promise<void>
  /** Read one pack-scoped setting value (raw persisted value; renderer coerces). */
  getSetting(packId: string, key: string): unknown
  /** Persist one pack-scoped setting value under the pack's namespaced bag. */
  setSetting(packId: string, key: string, value: unknown): Promise<void>
  /** Reconcile explicitly selected pack sources into the registry. */
  refreshPackSources(): Promise<void>
  /**
   * Discover Agent Plugins packages under the Copse-owned plugin root and give
   * each a registry row. Stage A2 of `docs/plans/agent-plugins-migration.md`.
   */
  refreshUserPlugins(): Promise<void>
  /** Persist and discover one directory selected through the host-owned native dialog. */
  addPackSource(sourcePath: string): Promise<void>
}

/**
 * Build a pack service backed by the given registry. The persisted disable set
 * is applied before returning, so subsequent `getDefaultPackRegistry()` /
 * `createHookRegistry()` calls see the same enablement the Settings list will
 * show. Exposed for tests; production callers go through `getPackService`.
 */
/**
 * Why a selected pack ended up unusable, keyed by pack id — and, for sources
 * that never yielded a pack at all, keyed by source path.
 *
 * `refreshPackSources` is the only place that sees the real cause: the runtime
 * threw, or the source would not load. Until now it went solely to a
 * `console.warn`, which in CI lives inside a failure artifact. Anything
 * downstream could therefore report the resulting *state* ("is disabled") but
 * never the reason, so diagnosing a pack that would not start meant fetching
 * that artifact by hand. Holding the reason here lets the error a caller
 * already throws carry it.
 *
 * Module-scoped to match `getDefaultPackRegistry()` — read sites reach for it
 * the same way they reach for the registry, without threading a service
 * instance through.
 */
const packUnavailableReasons = new Map<string, string>()
const inertSourceReasons = new Map<string, string>()

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Why this pack is not usable, when {@link refreshPackSources} recorded a cause. */
export function packUnavailableReason(packId: string): string | undefined {
  return packUnavailableReasons.get(packId)
}

/**
 * Sources that failed discovery, as `path: reason`. A pack missing from the
 * registry entirely is usually explained by one of these rather than by
 * anything keyed on its id — discovery never got far enough to learn the id.
 */
export function inertPackSources(): readonly string[] {
  return [...inertSourceReasons].map(([source, reason]) => `${source}: ${reason}`)
}

export function createPackService(registry: PackRegistry): PackService {
  const disabled = readDisabledIds()
  const selectedCandidates = new Map<string, PackToolSourceCandidate>()
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
        // A first-party or selected-directory pack already owns this id.
        // Refusing here keeps the incumbent working rather than throwing.
        inertSourceReasons.set(
          candidate.pluginRoot,
          `plugin id ${JSON.stringify(id)} is already registered`,
        )
        console.warn(`[plugins] ${candidate.pluginRoot} conflicts with a registered pack id.`)
        continue
      }
      for (const warning of candidate.warnings) {
        console.warn(`[plugins] ${id}: ${warning}`)
      }
      registry.register(registeredUserPlugin(candidate))
      userPlugins.set(id, candidate)
      if (!knownPluginIds().has(id)) fresh.push(id)
    }

    // A plugin seen for the first time is seeded **off**. `packDisabled` alone
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
      await storageUpdate(PACK_DISABLED_KEY, (raw) => {
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

  async function refreshPackSources(): Promise<void> {
    const sources = parseStringList(storageGet(PACK_SOURCES_KEY))
    const discovered: PackToolSourceCandidate[] = []
    for (const source of sources) {
      try {
        discovered.push(await discoverPackToolSource(source))
        inertSourceReasons.delete(source)
      } catch (error) {
        inertSourceReasons.set(source, describeError(error))
        console.warn(`[packs] selected source ${JSON.stringify(source)} is inert:`, error)
      }
    }

    const controller = getPackToolRuntimeController()
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
          `[packs] selected pack id ${JSON.stringify(id)} conflicts with a registered pack.`,
        )
        continue
      }
      if (!existing) {
        registry.register(registeredPackToolSource(candidate))
        selectedCandidates.set(id, candidate)
      }
      const current = selectedCandidates.get(id)
      if (!current) continue
      const shouldRun = !readDisabledIds().has(id)
      if (shouldRun && controller) {
        try {
          await controller.enable(current)
          registry.enable(id)
          packUnavailableReasons.delete(id)
        } catch (error) {
          registry.disable(id)
          // Note the cause before disabling loses it. This is the branch the
          // selected-pack e2e lands in when the OS sandbox is unavailable:
          // pack behavior fails closed, so the pack is registered and then
          // switched off, which on its own is indistinguishable from a user
          // having turned it off.
          packUnavailableReasons.set(id, describeError(error))
          console.warn(`[packs] pack ${JSON.stringify(id)} tools could not start:`, error)
        }
      } else {
        registry.disable(id)
        packUnavailableReasons.set(id, 'disabled in Settings → Packs')
        if (controller?.isRunning(id)) await controller.disable(id)
      }
    }
  }

  return {
    registry,
    list(): readonly PackSummaryOut[] {
      return summarizePacks(registry, (packId, key) => readPackSettings(packId)[key]).map(
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
    async setEnabled(packId: string, enabled: boolean): Promise<void> {
      if (!registry.has(packId)) return
      const selected = selectedCandidates.get(packId)
      if (selected) {
        if (!enabled) {
          registry.disable(packId)
          const controller = getPackToolRuntimeController()
          if (controller?.isRunning(packId)) await controller.disable(packId)
          await storageUpdate(PACK_DISABLED_KEY, (raw) => {
            const set = new Set(parseStringList(raw))
            set.add(packId)
            return [...set].sort()
          })
          return
        }
        const controller = getPackToolRuntimeController()
        if (!controller) {
          throw new Error(`pack "${packId}" runtime is unavailable`)
        }
        await controller.enable(selected)
        registry.enable(packId)
        await storageUpdate(PACK_DISABLED_KEY, (raw) => {
          const set = new Set(parseStringList(raw))
          set.delete(packId)
          return [...set].sort()
        })
        return
      }
      if (enabled) registry.enable(packId)
      else registry.disable(packId)
      await storageUpdate(PACK_DISABLED_KEY, (raw) => {
        const set = new Set(parseStringList(raw))
        if (enabled) set.delete(packId)
        else set.add(packId)
        return [...set].sort()
      })
    },
    getSetting(packId: string, key: string): unknown {
      return readPackSettings(packId)[key]
    },
    async setSetting(packId: string, key: string, value: unknown): Promise<void> {
      // Only keys the pack's manifest declares are persistable (P3 review): the
      // IPC caps value size, but without this any renderer bug (or compromise)
      // could grow arbitrary keys in any pack's bag forever.
      const pack = registry.has(packId) ? registry.get(packId) : undefined
      const declared = pack?.manifest.settings
      if (!declared || !(key in declared)) {
        throw new Error(`pack "${packId}" declares no setting "${key}"`)
      }
      await storageUpdate(packSettingsKey(packId), (raw) => {
        const current: Record<string, unknown> = isRecord(raw) ? { ...raw } : {}
        current[key] = value
        return current
      })
    },
    refreshPackSources,
    refreshUserPlugins,
    async addPackSource(sourcePath: string): Promise<void> {
      const candidate = await discoverPackToolSource(sourcePath)
      if (
        registry.has(candidate.manifest.name) &&
        !selectedCandidates.has(candidate.manifest.name)
      ) {
        throw new Error(`pack id "${candidate.manifest.name}" is already registered`)
      }
      await storageUpdate(PACK_SOURCES_KEY, (raw) => {
        const sources = new Set(parseStringList(raw))
        sources.add(candidate.sourcePath)
        return [...sources].sort()
      })
      await storageUpdate(PACK_DISABLED_KEY, (raw) => {
        const ids = new Set(parseStringList(raw))
        ids.delete(candidate.manifest.name)
        return [...ids].sort()
      })
      await refreshPackSources()
    },
  }
}

/**
 * Boot the process-wide pack service and install its registry as the loop's
 * default. Safe to call multiple times — the second call returns the existing
 * singleton, which is exactly what the IPC handlers rely on.
 */
export function getPackService(): PackService {
  if (singleton) return singleton
  seedDefaultDisabledPacks()
  migrateBackgroundTasksStable()
  migratePackModelSettings()
  migrateAutomationsEnablement()
  migrateParallelSearchEnablement()
  const registry = createFirstPartyPackRegistry()
  const service = createPackService(registry)
  setDefaultPackRegistry(registry)
  singleton = service
  return service
}

/** Reset for tests. Not exported through the barrel; tests import it directly. */
export function __resetPackServiceForTests(): void {
  singleton = null
  setDefaultPackRegistry(null)
  setPackToolRuntimeController(null)
  setPackBrowserService(null)
}
