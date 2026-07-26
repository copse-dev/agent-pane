// Pack service — P3 of docs/plans/hooks-and-feature-packs.md.
//
// The host wiring for the feature-pack layer:
//  - owns the **shared** `PackRegistry` (first-party packs registered), and
//    installs it via `setDefaultPackRegistry` so `createHookRegistry` (called
//    every turn) reads through the same instance the Settings UI toggles;
//  - applies the user's explicit enablement choices from `electron-store` on top
//    of each manifest's declared default, before wiring the provider, so a pack
//    the user toggled stays that way across relaunches;
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
// **Default enablement is the manifest's job, not this file's.** A pack declares
// `defaultEnabled: false` to ship off (`pack-manifest.ts`), and
// `PackRegistry.register` applies it. This service persists only the choices a
// user actually made, so an untouched pack keeps following its declaration and a
// registry built without this service is still correct. That replaces the tower
// of one-shot `migrate*Enablement()` functions this file used to carry: each
// retired standalone setting needed its own function, storage key, and pair of
// tests, and each one silently baked "whatever the default was on the boot it
// happened to run" into persisted state.
//
// Storage layout under the shared `electron-store`:
//   `packEnablement`         → Record<string, boolean> (EXPLICIT user choices only)
//   `pack.<packId>.settings` → Record<string, unknown> (values keyed by field id)
//
// Absence from `packEnablement` means "no opinion — use the manifest default",
// which is why it replaced the older `packDisabled` array: a bare list of
// disabled ids cannot distinguish "off by default" from "the user turned this
// off", so it could not express a user enabling a default-off pack. A legacy
// `packDisabled` array is folded in on read (see {@link readEnablementPrefs}).
// Pack settings are bagged per pack to keep the top-level key namespace clean
// and let the P4 todos pack lift/shift its config into a single record.
import type { PackRegistry } from '@copse/agent/packs/pack-registry.ts'
import { createFirstPartyPackRegistry } from '@copse/agent/packs/first-party-packs.ts'
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
import { storageGet, storageSet, storageUpdate } from '../storage/storage.ts'
import { getSetting } from '../storage/settings.ts'
import { parseStringList } from '../storage/storage-schema.ts'

/**
 * Storage key holding the user's EXPLICIT pack enablement choices, keyed by pack
 * id. Absence means "no choice made" — the pack follows its manifest default.
 */
const PACK_ENABLEMENT_KEY = 'packEnablement'

/**
 * The pre-`packEnablement` shape: a bare array of disabled pack ids. Folded into
 * the preference map on read so an existing user's explicit disables survive.
 */
const LEGACY_PACK_DISABLED_KEY = 'packDisabled'

/** One-time bridge from the retired top-level model settings now owned by packs. */
const PACK_MODEL_SETTINGS_MIGRATION_KEY = 'packMigration.packModelSettings'

/** Storage key holding one pack's settings values (`packId` scoped). */
function packSettingsKey(packId: string): string {
  return `pack.${packId}.settings`
}

/**
 * The user's explicit enablement choices. Reads the `packEnablement` map, then
 * folds in any legacy `packDisabled` array for ids the map does not already
 * mention — an explicit disable from before this key existed is still an
 * explicit choice, so it must outrank the manifest default.
 *
 * Deliberately a read-time fold rather than a one-shot migration: there is no
 * migration key to guard, nothing to re-run, and no way for it to bake a
 * default into persisted state. Ids the user never touched simply stay absent.
 */
function readEnablementPrefs(): Map<string, boolean> {
  const prefs = new Map<string, boolean>()
  const raw = storageGet(PACK_ENABLEMENT_KEY)
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [packId, enabled] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof enabled === 'boolean') prefs.set(packId, enabled)
    }
  }
  for (const packId of parseStringList(storageGet(LEGACY_PACK_DISABLED_KEY))) {
    if (!prefs.has(packId)) prefs.set(packId, false)
  }
  return prefs
}

/** Read one pack's persisted settings bag (`{}` when nothing stored). */
function readPackSettings(packId: string): Record<string, unknown> {
  const raw = storageGet(packSettingsKey(packId))
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as Record<string, unknown>
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
 * Build a pack service backed by the given registry. The registry already
 * carries each pack's declared default (applied in `PackRegistry.register`);
 * this layers the user's explicit choices on top before returning, so
 * subsequent `getDefaultPackRegistry()` / `createHookRegistry()` calls see the
 * same enablement the Settings list will show. A pack the user never toggled is
 * left exactly as its manifest declared. Exposed for tests; production callers
 * go through `getPackService`.
 */
export function createPackService(registry: PackRegistry): PackService {
  for (const [packId, enabled] of readEnablementPrefs()) {
    if (!registry.has(packId)) continue
    if (enabled) registry.enable(packId)
    else registry.disable(packId)
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
      // Record the choice explicitly in both directions. Writing `true` matters
      // as much as writing `false`: for a `defaultEnabled: false` pack it is the
      // only way to say "the user opted in", which the old disabled-ids array
      // had no way to represent.
      await storageUpdate(PACK_ENABLEMENT_KEY, (raw) => {
        const current: Record<string, unknown> =
          raw && typeof raw === 'object' && !Array.isArray(raw)
            ? { ...(raw as Record<string, unknown>) }
            : {}
        current[packId] = enabled
        return current
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
        const current: Record<string, unknown> =
          raw && typeof raw === 'object' && !Array.isArray(raw)
            ? { ...(raw as Record<string, unknown>) }
            : {}
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
  // Enablement needs no migration: each pack declares its own default and
  // `readEnablementPrefs()` folds the legacy `packDisabled` array in on read.
  // The model-settings lift is not enablement — it moves values the user
  // authored, which no manifest default can reconstruct — so it stays.
  migratePackModelSettings()
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
}
