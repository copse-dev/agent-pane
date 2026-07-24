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
import { createFirstPartyPackRegistry } from '@copse/agent/packs/first-party-packs.ts'
import { setDefaultPackRegistry } from '@copse/agent/packs/default-pack-registry.ts'
import { summarizePacks, type PackSummaryOut } from '@copse/agent/packs/pack-summary.ts'
import {
  MODEL_COMPARISON_PACK_ID,
  COMPARISON_MODEL_A_SETTING_ID,
  COMPARISON_MODEL_B_SETTING_ID,
  COMPARISON_JUDGE_MODEL_SETTING_ID,
} from '@copse/agent/packs/model-comparison-pack.ts'
import { POST_TURN_REVIEW_PACK_ID } from '@copse/agent/packs/post-turn-review-pack.ts'
import { LONG_HORIZON_TASKS_PACK_ID } from '@copse/agent/packs/long-horizon-tasks-pack.ts'
import { ROADMAP_PLANS_PACK_ID } from '@copse/agent/packs/roadmap-plans-pack.ts'
import {
  ADVISOR_STRATEGY_PACK_ID,
  ADVISOR_MODEL_SETTING_ID,
} from '@copse/agent/packs/advisor-strategy-pack.ts'
import { OKF_MEMORIES_PACK_ID } from '@copse/agent/packs/okf-memories-pack.ts'
import { CI_INVESTIGATOR_PACK_ID } from '@copse/agent/packs/ci-investigator-pack.ts'
import { PII_REDACTION_PACK_ID } from '@copse/agent/packs/pii-redaction-pack.ts'
import { MCP_UI_CANVAS_PACK_ID } from '@copse/agent/packs/mcp-ui-canvas-pack.ts'
import { DEVTOOLS_SHORTCUT_PACK_ID } from '@copse/agent/packs/devtools-shortcut-pack.ts'
import { BACKGROUND_TASKS_PACK_ID } from '@copse/agent/packs/background-tasks-pack.ts'
import { storageGet, storageSet, storageUpdate } from '../storage/storage.ts'
import { getSetting } from '../storage/settings.ts'
import { parseStringList } from '../storage/storage-schema.ts'

/** Storage key holding the ids of packs the user disabled. */
const PACK_DISABLED_KEY = 'packDisabled'

/** One-time bridge from P5's retired standalone enablement settings. */
const P5_ENABLEMENT_MIGRATION_KEY = 'packMigration.p5Enablement'

/** One-time bridge from the retired `longHorizonTasksEnabled` standalone setting. */
const LONG_HORIZON_TASKS_ENABLEMENT_MIGRATION_KEY = 'packMigration.longHorizonTasksEnablement'

/** One-time bridge from the retired `roadmapPlansEnabled` standalone setting. */
const ROADMAP_PLANS_ENABLEMENT_MIGRATION_KEY = 'packMigration.roadmapPlansEnablement'

/** One-time bridge from the retired `advisorStrategyEnabled` standalone setting. */
const ADVISOR_STRATEGY_ENABLEMENT_MIGRATION_KEY = 'packMigration.advisorStrategyEnablement'

/** One-time bridge from the retired `okfMemoriesEnabled` standalone setting. */
const OKF_MEMORIES_ENABLEMENT_MIGRATION_KEY = 'packMigration.okfMemoriesEnablement'

/** One-time bridge from the retired `ciInvestigatorEnabled` standalone setting. */
const CI_INVESTIGATOR_ENABLEMENT_MIGRATION_KEY = 'packMigration.ciInvestigatorEnablement'

/** One-time bridge from the retired `piiRedactionEnabled` standalone setting. */
const PII_REDACTION_ENABLEMENT_MIGRATION_KEY = 'packMigration.piiRedactionEnablement'

/** One-time bridge from the retired `mcpUiArtefactsEnabled` standalone setting. */
const MCP_UI_CANVAS_ENABLEMENT_MIGRATION_KEY = 'packMigration.mcpUiCanvasEnablement'

/** One-time bridge from the retired `devtoolsShortcutEnabled` standalone setting. */
const DEVTOOLS_SHORTCUT_ENABLEMENT_MIGRATION_KEY = 'packMigration.devtoolsShortcutEnablement'

/** One-time bridge from the retired `backgroundTasksEnabled` standalone setting. */
const BACKGROUND_TASKS_ENABLEMENT_MIGRATION_KEY = 'packMigration.backgroundTasksEnablement'

/** One-time bridge from the retired top-level model settings now owned by packs. */
const PACK_MODEL_SETTINGS_MIGRATION_KEY = 'packMigration.packModelSettings'

/** Storage key holding one pack's settings values (`packId` scoped). */
function packSettingsKey(packId: string): string {
  return `pack.${packId}.settings`
}

/** Read the persisted disable set. */
function readDisabledIds(): Set<string> {
  return new Set(parseStringList(storageGet(PACK_DISABLED_KEY)))
}

/**
 * Preserve the enablement users had before post-turn review and model
 * comparison became packs. This must run synchronously before the shared
 * registry is created: `createRegistry()` immediately consults it to decide
 * whether `compare_models` belongs in the model's tool list.
 *
 * The old defaults were asymmetric — post-turn review on, model comparison
 * off. In particular, an absent `modelComparisonEnabled` value must disable
 * the new pack or P5 would expose an experimental, previously opt-in tool to
 * every existing user after upgrade.
 */
function migrateP5Enablement(): void {
  if (storageGet(P5_ENABLEMENT_MIGRATION_KEY) === true) return

  const disabled = readDisabledIds()
  const postTurnReviewEnabled = storageGet('postTurnReviewEnabled')
  const modelComparisonEnabled = storageGet('modelComparisonEnabled')

  if (postTurnReviewEnabled === false) disabled.add(POST_TURN_REVIEW_PACK_ID)
  else if (postTurnReviewEnabled === true) disabled.delete(POST_TURN_REVIEW_PACK_ID)

  if (modelComparisonEnabled === true) disabled.delete(MODEL_COMPARISON_PACK_ID)
  else disabled.add(MODEL_COMPARISON_PACK_ID)

  storageSet(PACK_DISABLED_KEY, [...disabled].sort())
  storageSet(P5_ENABLEMENT_MIGRATION_KEY, true)
}

/**
 * Preserve the enablement users had before long-horizon tasks became a pack.
 * Like model comparison, the feature was previously opt-in (off by default via
 * the `longHorizonTasksEnabled` setting), so an absent or false value must
 * disable the new `copse.long-horizon-tasks` pack — otherwise the migration
 * would expose a previously opt-in experimental tool to every existing user
 * after upgrade. Runs synchronously before the shared registry is created and
 * is idempotent (guarded by its own migration key).
 */
function migrateLongHorizonTasksEnablement(): void {
  if (storageGet(LONG_HORIZON_TASKS_ENABLEMENT_MIGRATION_KEY) === true) return

  const disabled = readDisabledIds()
  const longHorizonTasksEnabled = storageGet('longHorizonTasksEnabled')

  if (longHorizonTasksEnabled === true) disabled.delete(LONG_HORIZON_TASKS_PACK_ID)
  else disabled.add(LONG_HORIZON_TASKS_PACK_ID)

  storageSet(PACK_DISABLED_KEY, [...disabled].sort())
  storageSet(LONG_HORIZON_TASKS_ENABLEMENT_MIGRATION_KEY, true)
}

/**
 * Preserve the enablement users had before roadmap plans became a pack. Like
 * model comparison, the feature was previously opt-in (off by default via the
 * `roadmapPlansEnabled` setting), so an absent or false value must disable the
 * new `copse.roadmap-plans` pack — otherwise the migration would expose a
 * previously opt-in experimental tool (and its Roadmap pane) to every existing
 * user after upgrade. Runs synchronously before the shared registry is created
 * and is idempotent (guarded by its own migration key).
 */
function migrateRoadmapPlansEnablement(): void {
  if (storageGet(ROADMAP_PLANS_ENABLEMENT_MIGRATION_KEY) === true) return

  const disabled = readDisabledIds()
  const roadmapPlansEnabled = storageGet('roadmapPlansEnabled')

  if (roadmapPlansEnabled === true) disabled.delete(ROADMAP_PLANS_PACK_ID)
  else disabled.add(ROADMAP_PLANS_PACK_ID)

  storageSet(PACK_DISABLED_KEY, [...disabled].sort())
  storageSet(ROADMAP_PLANS_ENABLEMENT_MIGRATION_KEY, true)
}

/**
 * Preserve the enablement users had before the advisor strategy became a pack.
 * Like model comparison, the feature was previously opt-in (off by default via
 * the `advisorStrategyEnabled` setting), so an absent or false value must
 * disable the new `copse.advisor-strategy` pack — otherwise the migration would
 * expose a previously opt-in experimental tool to every existing user after
 * upgrade. The orthogonal `advisorModel` setting is left untouched (it is not a
 * pack enablement flag). Runs synchronously before the shared registry is
 * created and is idempotent (guarded by its own migration key).
 */
function migrateAdvisorStrategyEnablement(): void {
  if (storageGet(ADVISOR_STRATEGY_ENABLEMENT_MIGRATION_KEY) === true) return

  const disabled = readDisabledIds()
  const advisorStrategyEnabled = storageGet('advisorStrategyEnabled')

  if (advisorStrategyEnabled === true) disabled.delete(ADVISOR_STRATEGY_PACK_ID)
  else disabled.add(ADVISOR_STRATEGY_PACK_ID)

  storageSet(PACK_DISABLED_KEY, [...disabled].sort())
  storageSet(ADVISOR_STRATEGY_ENABLEMENT_MIGRATION_KEY, true)
}

/**
 * Preserve the enablement users had before OKF memories became a pack. Like
 * model comparison, the feature was previously opt-in (off by default via the
 * `okfMemoriesEnabled` setting), so an absent or false value must disable the
 * new `copse.okf-memories` pack — otherwise the migration would expose a
 * previously opt-in experimental tool (and its prompt block + Memories pane) to
 * every existing user after upgrade. Runs synchronously before the shared
 * registry is created and is idempotent (guarded by its own migration key).
 */
function migrateOkfMemoriesEnablement(): void {
  if (storageGet(OKF_MEMORIES_ENABLEMENT_MIGRATION_KEY) === true) return

  const disabled = readDisabledIds()
  const okfMemoriesEnabled = storageGet('okfMemoriesEnabled')

  if (okfMemoriesEnabled === true) disabled.delete(OKF_MEMORIES_PACK_ID)
  else disabled.add(OKF_MEMORIES_PACK_ID)

  storageSet(PACK_DISABLED_KEY, [...disabled].sort())
  storageSet(OKF_MEMORIES_ENABLEMENT_MIGRATION_KEY, true)
}

/**
 * Preserve the enablement users had before the CI investigator became a pack.
 * Like model comparison, the feature was previously opt-in (off by default via
 * the `ciInvestigatorEnabled` setting), so an absent or false value must disable
 * the new `copse.ci-investigator` pack — otherwise the migration would expose a
 * previously opt-in experimental tool to every existing user after upgrade. Runs
 * synchronously before the shared registry is created and is idempotent (guarded
 * by its own migration key).
 */
function migrateCiInvestigatorEnablement(): void {
  if (storageGet(CI_INVESTIGATOR_ENABLEMENT_MIGRATION_KEY) === true) return

  const disabled = readDisabledIds()
  const ciInvestigatorEnabled = storageGet('ciInvestigatorEnabled')

  if (ciInvestigatorEnabled === true) disabled.delete(CI_INVESTIGATOR_PACK_ID)
  else disabled.add(CI_INVESTIGATOR_PACK_ID)

  storageSet(PACK_DISABLED_KEY, [...disabled].sort())
  storageSet(CI_INVESTIGATOR_ENABLEMENT_MIGRATION_KEY, true)
}

/**
 * Preserve the enablement users had before client-side PII redaction became a
 * pack. Like model comparison, the feature was previously opt-in (off by default
 * via the `piiRedactionEnabled` setting), so an absent or false value must
 * disable the new `copse.pii-redaction` pack — otherwise the migration would
 * silently start rewriting the input of, and expose the reveal tool to, every
 * existing user after upgrade. This preserves the default-OFF invariant: it runs
 * synchronously before the shared registry is created (which `pii-redactor.ts`
 * and `registry-bootstrap.ts` immediately consult) and is idempotent (guarded by
 * its own migration key). A separate function/key from `migrateP5Enablement`
 * keeps the migrations conflict-free.
 */
function migratePiiRedactionEnablement(): void {
  if (storageGet(PII_REDACTION_ENABLEMENT_MIGRATION_KEY) === true) return

  const disabled = readDisabledIds()
  const piiRedactionEnabled = storageGet('piiRedactionEnabled')

  if (piiRedactionEnabled === true) disabled.delete(PII_REDACTION_PACK_ID)
  else disabled.add(PII_REDACTION_PACK_ID)

  storageSet(PACK_DISABLED_KEY, [...disabled].sort())
  storageSet(PII_REDACTION_ENABLEMENT_MIGRATION_KEY, true)
}

/**
 * Preserve the enablement users had before the MCP-UI canvas became a pack. The
 * feature was opt-in (off by default via the `mcpUiArtefactsEnabled` setting), so
 * an absent or false value must disable the new `copse.mcp-ui-canvas` pack —
 * otherwise the migration would silently start rendering MCP-UI resources as
 * sandboxed artefacts (and connect the bundled canvas server) for every existing
 * user after upgrade. This preserves the default-OFF invariant: it runs
 * synchronously before the shared registry is created (which `mcp-registry.ts`
 * consults via `isCapabilityActive`) and is idempotent (guarded by its own key).
 */
function migrateMcpUiCanvasEnablement(): void {
  if (storageGet(MCP_UI_CANVAS_ENABLEMENT_MIGRATION_KEY) === true) return

  const disabled = readDisabledIds()
  const mcpUiArtefactsEnabled = storageGet('mcpUiArtefactsEnabled')

  if (mcpUiArtefactsEnabled === true) disabled.delete(MCP_UI_CANVAS_PACK_ID)
  else disabled.add(MCP_UI_CANVAS_PACK_ID)

  storageSet(PACK_DISABLED_KEY, [...disabled].sort())
  storageSet(MCP_UI_CANVAS_ENABLEMENT_MIGRATION_KEY, true)
}

/**
 * Preserve the enablement users had before the DevTools shortcut became a pack.
 * The feature was opt-in (off by default via the `devtoolsShortcutEnabled`
 * setting), so an absent or false value must disable the new
 * `copse.devtools-shortcut` pack — otherwise the migration would silently
 * register the global Ctrl+Shift+I shortcut for every existing user after
 * upgrade. Runs synchronously before the shared registry is created (which
 * `create-main-window.ts` consults via `isCapabilityActive` at boot) and is
 * idempotent (guarded by its own key).
 */
function migrateDevtoolsShortcutEnablement(): void {
  if (storageGet(DEVTOOLS_SHORTCUT_ENABLEMENT_MIGRATION_KEY) === true) return

  const disabled = readDisabledIds()
  const devtoolsShortcutEnabled = storageGet('devtoolsShortcutEnabled')

  if (devtoolsShortcutEnabled === true) disabled.delete(DEVTOOLS_SHORTCUT_PACK_ID)
  else disabled.add(DEVTOOLS_SHORTCUT_PACK_ID)

  storageSet(PACK_DISABLED_KEY, [...disabled].sort())
  storageSet(DEVTOOLS_SHORTCUT_ENABLEMENT_MIGRATION_KEY, true)
}

/**
 * Preserve the enablement users had before background tasks became a pack. The
 * feature was opt-in (off by default via the `backgroundTasksEnabled` setting),
 * so an absent or false value must disable the new `copse.background-tasks` pack
 * — otherwise the migration would silently register the `run_background` tool
 * (and advertise the loopback-bind sandbox relaxation) for every existing user
 * after upgrade. This preserves the default-OFF invariant: it runs synchronously
 * before the shared registry is created (which `registry-bootstrap.ts` consults
 * via `isEnabled`, and `permission-gate.ts` via `isPermissionDeclared`) and is
 * idempotent (guarded by its own key). A user who had previously turned the
 * setting on keeps background tasks enabled.
 */
function migrateBackgroundTasksEnablement(): void {
  if (storageGet(BACKGROUND_TASKS_ENABLEMENT_MIGRATION_KEY) === true) return

  const disabled = readDisabledIds()
  const backgroundTasksEnabled = storageGet('backgroundTasksEnabled')

  if (backgroundTasksEnabled === true) disabled.delete(BACKGROUND_TASKS_PACK_ID)
  else disabled.add(BACKGROUND_TASKS_PACK_ID)

  storageSet(PACK_DISABLED_KEY, [...disabled].sort())
  storageSet(BACKGROUND_TASKS_ENABLEMENT_MIGRATION_KEY, true)
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
  migrateP5Enablement()
  migrateLongHorizonTasksEnablement()
  migrateRoadmapPlansEnablement()
  migrateAdvisorStrategyEnablement()
  migrateOkfMemoriesEnablement()
  migrateCiInvestigatorEnablement()
  migratePiiRedactionEnablement()
  migrateMcpUiCanvasEnablement()
  migrateDevtoolsShortcutEnablement()
  migrateBackgroundTasksEnablement()
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
