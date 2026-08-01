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
 * Packs that ship registered but off.
 *
 * `createFirstPartyPackRegistry()` seeds every pack enabled. The off-by-default
 * set is derived from each first-party manifest's `experimental` stability and
 * written into `packDisabled` on a profile that has never had one. This makes a
 * forgotten rollout-list update impossible when a new experiment is added.
 *
 * The three packs added with the contribution kinds (#1188-#1190) join the list
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
const DEFAULT_DISABLED_PACK_IDS: readonly string[] = EXPERIMENTAL_FIRST_PARTY_PACK_IDS

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
   * Resolve once no source reconciliation is in flight.
   *
   * Startup kicks `refreshPackSources()` off without awaiting it
   * (`register-handlers.ts`), so the window is interactive well before a
   * selected pack's runtime has been discovered and spawned. Anything that
   * reads pack enablement to decide whether to fail a user's request has to
   * settle first, or it races startup and rejects a pack that is merely late.
   *
   * Never rejects: a failed reconciliation is already logged and leaves the
   * registry authoritative (the pack stays disabled), which callers then read
   * as usual.
   */
  whenPackSourcesSettled(): Promise<void>
  /** Persist and discover one directory selected through the host-owned native dialog. */
  addPackSource(sourcePath: string): Promise<void>
}

/**
 * Build a pack service backed by the given registry. The persisted disable set
 * is applied before returning, so subsequent `getDefaultPackRegistry()` /
 * `createHookRegistry()` calls see the same enablement the Settings list will
 * show. Exposed for tests; production callers go through `getPackService`.
 */
export function createPackService(registry: PackRegistry): PackService {
  const disabled = readDisabledIds()
  const selectedCandidates = new Map<string, PackToolSourceCandidate>()
  for (const id of disabled) {
    if (registry.has(id)) registry.disable(id)
  }

  // The reconciliation currently in flight, so readers can settle behind it
  // rather than racing an unawaited startup call. Cleared when it finishes, and
  // replaced wholesale by a later refresh (each one reconciles from scratch, so
  // waiting on the newest is always sufficient).
  let pendingSourceRefresh: Promise<void> | null = null

  function trackRefreshPackSources(): Promise<void> {
    const run = reconcilePackSources().finally(() => {
      if (pendingSourceRefresh === run) pendingSourceRefresh = null
    })
    pendingSourceRefresh = run
    return run
  }

  async function reconcilePackSources(): Promise<void> {
    const sources = parseStringList(storageGet(PACK_SOURCES_KEY))
    const discovered: PackToolSourceCandidate[] = []
    for (const source of sources) {
      try {
        discovered.push(await discoverPackToolSource(source))
      } catch (error) {
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
        } catch (error) {
          registry.disable(id)
          console.warn(`[packs] pack ${JSON.stringify(id)} tools could not start:`, error)
        }
      } else {
        registry.disable(id)
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
    refreshPackSources: trackRefreshPackSources,
    async whenPackSourcesSettled(): Promise<void> {
      // Swallow: a failed reconciliation already logged, and left the registry
      // authoritative. Callers read enablement next, not this promise's result.
      await pendingSourceRefresh?.catch(() => undefined)
    },
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
      await trackRefreshPackSources()
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
