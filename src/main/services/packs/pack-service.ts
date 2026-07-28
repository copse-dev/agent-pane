// Pack service — P3 of docs/plans/hooks-and-feature-packs.md (+ marketplace P1).
//
// The host wiring for the feature-pack layer:
//  - owns the **shared** `PackRegistry` (first-party packs registered), and
//    installs it via `setDefaultPackRegistry` so `createHookRegistry` (called
//    every turn) reads through the same instance the Settings UI toggles;
//  - discovers local **user** packs under `~/.copse/packs/` (or `COPSE_PACKS_DIR`)
//    and registers them before applying the disable set (marketplace P1);
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
import { createFirstPartyPackRegistry } from '@copse/agent/packs/first-party-packs.ts'
import { setDefaultPackRegistry } from '@copse/agent/packs/default-pack-registry.ts'
import { summarizePacks, type PackSummaryOut } from '@copse/agent/packs/pack-summary.ts'
import { discoverAndRegisterUserPacks } from './discover-user-packs.ts'
import {
  MODEL_COMPARISON_PACK_ID,
  COMPARISON_MODEL_A_SETTING_ID,
  COMPARISON_MODEL_B_SETTING_ID,
  COMPARISON_JUDGE_MODEL_SETTING_ID,
} from '@copse/agent/packs/model-comparison-pack.ts'
import { LONG_HORIZON_TASKS_PACK_ID } from '@copse/agent/packs/long-horizon-tasks-pack.ts'
import { ROADMAP_PLANS_PACK_ID } from '@copse/agent/packs/roadmap-plans-pack.ts'
import {
  ADVISOR_STRATEGY_PACK_ID,
  ADVISOR_MODEL_SETTING_ID,
} from '@copse/agent/packs/advisor-strategy-pack.ts'
import { OKF_MEMORIES_PACK_ID } from '@copse/agent/packs/okf-memories-pack.ts'
import { CI_INVESTIGATOR_PACK_ID } from '@copse/agent/packs/ci-investigator-pack.ts'
import { PII_REDACTION_PACK_ID } from '@copse/agent/packs/pii-redaction-pack.ts'
import { FORCED_PLANNING_PACK_ID } from '@copse/agent/packs/forced-planning-pack.ts'
import { MCP_UI_CANVAS_PACK_ID } from '@copse/agent/packs/mcp-ui-canvas-pack.ts'
import { DEVTOOLS_SHORTCUT_PACK_ID } from '@copse/agent/packs/devtools-shortcut-pack.ts'
import { BACKGROUND_TASKS_PACK_ID } from '@copse/agent/packs/background-tasks-pack.ts'
import { AUTOMATIONS_PACK_ID } from '@copse/agent/packs/automations-pack.ts'
import { storageGet, storageSet, storageUpdate } from '../storage/storage.ts'
import { getSetting } from '../storage/settings.ts'
import { parseStringList } from '../storage/storage-schema.ts'

/** One-time bridge from the retired top-level model settings now owned by packs. */
const PACK_MODEL_SETTINGS_MIGRATION_KEY = 'packMigration.packModelSettings'

/** Storage key holding the ids of packs the user disabled. */
const PACK_DISABLED_KEY = 'packDisabled'

/**
 * Packs that ship registered but off.
 *
 * `createFirstPartyPackRegistry()` seeds every pack enabled, so the off-by-
 * default set is declared here and written into `packDisabled` on a profile
 * that has never had one. Every id below was opt-in before it became a pack,
 * and `copse.pii-redaction` additionally rewrites model input — defaulting any
 * of them on would hand an experimental surface to someone who never asked for
 * it. `copse.post-turn-review` is deliberately absent: it has always been on.
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
const DEFAULT_DISABLED_PACK_IDS: readonly string[] = [
  ADVISOR_STRATEGY_PACK_ID,
  AUTOMATIONS_PACK_ID,
  BACKGROUND_TASKS_PACK_ID,
  CI_INVESTIGATOR_PACK_ID,
  DEVTOOLS_SHORTCUT_PACK_ID,
  FORCED_PLANNING_PACK_ID,
  LONG_HORIZON_TASKS_PACK_ID,
  MCP_UI_CANVAS_PACK_ID,
  MODEL_COMPARISON_PACK_ID,
  OKF_MEMORIES_PACK_ID,
  PII_REDACTION_PACK_ID,
  ROADMAP_PLANS_PACK_ID,
]

/** One-time default-off seed for the new local automations prototype. */
const AUTOMATIONS_ENABLEMENT_MIGRATION_KEY = 'packMigration.automationsEnablement'

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
}

/**
 * Build a pack service backed by the given registry. The persisted disable set
 * is applied before returning, so subsequent `getDefaultPackRegistry()` /
 * `createHookRegistry()` calls see the same enablement the Settings list will
 * show. Exposed for tests; production callers go through `getPackService`.
 */
export function createPackService(registry: PackRegistry): PackService {
  const disabled = readDisabledIds()
  for (const id of disabled) {
    if (registry.has(id)) registry.disable(id)
  }

  return {
    registry,
    list(): readonly PackSummaryOut[] {
      return summarizePacks(registry, (packId, key) => readPackSettings(packId)[key])
    },
    async setEnabled(packId: string, enabled: boolean): Promise<void> {
      if (!registry.has(packId)) return
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
  const registry = createFirstPartyPackRegistry()
  // Marketplace P1: local user-pack discovery before disable-set apply so a
  // previously disabled user pack stays off across relaunch. Missing packs root
  // is inert. Duplicate ids / bad manifests are skipped per-entry.
  discoverAndRegisterUserPacks(registry)
  const service = createPackService(registry)
  setDefaultPackRegistry(registry)
  singleton = service
  return service
}

/** Reset for tests. Not exported through the barrel; tests import it directly. */
export function __resetPackServiceForTests(): void {
  singleton = null
  setDefaultPackRegistry(null)
}
