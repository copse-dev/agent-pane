// PackService — P3 host wiring (docs/plans/hooks-and-feature-packs.md).
//
// Pins the invariants the Settings pack list depends on:
//  - `setEnabled(false)` flips the shared registry's flag AND persists to
//    `electron-store`, so the loop sees the disable immediately (atomic — P1
//    contract) and the toggle survives relaunch.
//  - Pack settings persist under a pack-scoped bag, keyed by field id.
//  - The list snapshot reflects the current registry state + persisted values.
//
// electron-store is replaced by the shared test-shim (`storage.test-shim.ts`,
// wired in `scripts/run-tests.mts`), so writes go through the same
// write-queue used in production but land in an in-memory Map.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PackRegistry } from '@copse/agent/packs/pack-registry.ts'
import { definePack } from '@copse/agent/packs/pack-manifest.ts'
import { MODEL_COMPARISON_PACK_ID } from '@copse/agent/packs/model-comparison-pack.ts'
import { POST_TURN_REVIEW_PACK_ID } from '@copse/agent/packs/post-turn-review-pack.ts'
import { LONG_HORIZON_TASKS_PACK_ID } from '@copse/agent/packs/long-horizon-tasks-pack.ts'
import { ROADMAP_PLANS_PACK_ID } from '@copse/agent/packs/roadmap-plans-pack.ts'
import { ADVISOR_STRATEGY_PACK_ID } from '@copse/agent/packs/advisor-strategy-pack.ts'
import { OKF_MEMORIES_PACK_ID } from '@copse/agent/packs/okf-memories-pack.ts'
import { CI_INVESTIGATOR_PACK_ID } from '@copse/agent/packs/ci-investigator-pack.ts'
import { PII_REDACTION_PACK_ID } from '@copse/agent/packs/pii-redaction-pack.ts'
import { MCP_UI_CANVAS_PACK_ID } from '@copse/agent/packs/mcp-ui-canvas-pack.ts'
import { DEVTOOLS_SHORTCUT_PACK_ID } from '@copse/agent/packs/devtools-shortcut-pack.ts'
import { BACKGROUND_TASKS_PACK_ID } from '@copse/agent/packs/background-tasks-pack.ts'
import { storageDelete, storageGet, storageSet } from '../storage/storage.ts'
import { __resetPackServiceForTests, createPackService, getPackService } from './pack-service.ts'

const PACK_DISABLED_KEY = 'packDisabled'
const P5_ENABLEMENT_MIGRATION_KEY = 'packMigration.p5Enablement'
const LONG_HORIZON_TASKS_ENABLEMENT_MIGRATION_KEY = 'packMigration.longHorizonTasksEnablement'
const ROADMAP_PLANS_ENABLEMENT_MIGRATION_KEY = 'packMigration.roadmapPlansEnablement'
const ADVISOR_STRATEGY_ENABLEMENT_MIGRATION_KEY = 'packMigration.advisorStrategyEnablement'
const OKF_MEMORIES_ENABLEMENT_MIGRATION_KEY = 'packMigration.okfMemoriesEnablement'
const CI_INVESTIGATOR_ENABLEMENT_MIGRATION_KEY = 'packMigration.ciInvestigatorEnablement'
const PII_REDACTION_ENABLEMENT_MIGRATION_KEY = 'packMigration.piiRedactionEnablement'
const MCP_UI_CANVAS_ENABLEMENT_MIGRATION_KEY = 'packMigration.mcpUiCanvasEnablement'
const DEVTOOLS_SHORTCUT_ENABLEMENT_MIGRATION_KEY = 'packMigration.devtoolsShortcutEnablement'
const BACKGROUND_TASKS_ENABLEMENT_MIGRATION_KEY = 'packMigration.backgroundTasksEnablement'
const packSettingsKey = (id: string): string => `pack.${id}.settings`

function makeRegistry(): PackRegistry {
  const registry = new PackRegistry()
  registry.register(
    definePack(
      {
        name: 'demo.pack',
        trust: 'first-party',
        description: 'demo pack',
        storage: { namespace: 'demo.pack' },
        settings: {
          budget: { kind: 'number', title: 'Budget', default: 3 },
          label: { kind: 'string', title: 'Label', default: 'hi' },
        },
      },
      { toolNames: ['demo_tool'] },
    ),
  )
  registry.register(
    definePack({
      name: 'copse.other',
      trust: 'first-party',
      storage: { namespace: 'copse.other' },
    }),
  )
  return registry
}

function clearStorage(): void {
  storageSet(PACK_DISABLED_KEY, [])
  storageDelete(P5_ENABLEMENT_MIGRATION_KEY)
  storageDelete(LONG_HORIZON_TASKS_ENABLEMENT_MIGRATION_KEY)
  storageDelete(ROADMAP_PLANS_ENABLEMENT_MIGRATION_KEY)
  storageDelete(ADVISOR_STRATEGY_ENABLEMENT_MIGRATION_KEY)
  storageDelete(OKF_MEMORIES_ENABLEMENT_MIGRATION_KEY)
  storageDelete(CI_INVESTIGATOR_ENABLEMENT_MIGRATION_KEY)
  storageDelete(PII_REDACTION_ENABLEMENT_MIGRATION_KEY)
  // The two capability-only pack migrations + the background-tasks migration run
  // in the same getPackService() call as every other migration. Mark them done
  // by default so the existing per-pack migration assertions stay scoped to their
  // own pack; the dedicated tests below clear these keys to exercise them.
  storageSet(MCP_UI_CANVAS_ENABLEMENT_MIGRATION_KEY, true)
  storageSet(DEVTOOLS_SHORTCUT_ENABLEMENT_MIGRATION_KEY, true)
  storageSet(BACKGROUND_TASKS_ENABLEMENT_MIGRATION_KEY, true)
  storageDelete('mcpUiArtefactsEnabled')
  storageDelete('devtoolsShortcutEnabled')
  storageDelete('backgroundTasksEnabled')
  storageDelete('postTurnReviewEnabled')
  storageDelete('modelComparisonEnabled')
  storageDelete('longHorizonTasksEnabled')
  storageDelete('roadmapPlansEnabled')
  storageDelete('advisorStrategyEnabled')
  storageDelete('okfMemoriesEnabled')
  storageDelete('ciInvestigatorEnabled')
  storageDelete('piiRedactionEnabled')
  storageSet(packSettingsKey('demo.pack'), {})
  storageSet(packSettingsKey('copse.other'), {})
}

describe('PackService', () => {
  beforeEach(() => {
    __resetPackServiceForTests()
    clearStorage()
  })

  afterEach(() => {
    __resetPackServiceForTests()
  })

  it('lists every registered pack with its enablement + settings values', () => {
    const service = createPackService(makeRegistry())
    const packs = service.list()
    assert.deepEqual(
      packs.map((p) => p.id),
      ['demo.pack', 'copse.other'],
    )
    const demo = packs.find((p) => p.id === 'demo.pack')
    assert.ok(demo)
    assert.equal(demo.enabled, true)
    const byId = Object.fromEntries(demo.settings.map((f) => [f.id, f.value]))
    assert.deepEqual(byId, { budget: 3, label: 'hi' })
  })

  it('setEnabled(false) flips the shared registry flag and persists to storage', async () => {
    const registry = makeRegistry()
    const service = createPackService(registry)

    await service.setEnabled('demo.pack', false)
    assert.equal(registry.isEnabled('demo.pack'), false)
    // The loop reading through the registry sees the disable immediately —
    // atomic per the P1 contract.
    assert.deepEqual(registry.activeToolNames(), [])
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), ['demo.pack'])

    // Persisted on disk: a fresh registry + service pair inherits the disable.
    const laterRegistry = makeRegistry()
    createPackService(laterRegistry)
    assert.equal(laterRegistry.isEnabled('demo.pack'), false)
  })

  it('re-enabling drops the id from the persisted disable list', async () => {
    const registry = makeRegistry()
    const service = createPackService(registry)

    await service.setEnabled('demo.pack', false)
    await service.setEnabled('demo.pack', true)
    assert.equal(registry.isEnabled('demo.pack'), true)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [])
  })

  it('persists pack-scoped settings under a namespaced key and reflects them in list()', async () => {
    const registry = makeRegistry()
    const service = createPackService(registry)

    await service.setSetting('demo.pack', 'budget', 7)
    await service.setSetting('demo.pack', 'label', 'from-user')

    assert.deepEqual(storageGet(packSettingsKey('demo.pack')), { budget: 7, label: 'from-user' })

    const packs = service.list()
    const demo = packs.find((p) => p.id === 'demo.pack')
    assert.ok(demo)
    const byId = Object.fromEntries(demo.settings.map((f) => [f.id, f.value]))
    assert.deepEqual(byId, { budget: 7, label: 'from-user' })
  })

  it('rejects a setting key the pack does not declare (P3 review)', async () => {
    const registry = makeRegistry()
    const service = createPackService(registry)

    // The IPC caps the value size but not key legitimacy; without schema
    // validation any renderer bug could grow arbitrary keys in the bag forever.
    await assert.rejects(
      () => service.setSetting('demo.pack', 'not-declared', 'x'),
      /declares no setting "not-declared"/,
    )
    await assert.rejects(() => service.setSetting('no-such-pack', 'budget', 1))
    assert.deepEqual(storageGet(packSettingsKey('demo.pack')) ?? {}, {}, 'nothing persisted')
  })

  it('ignores setEnabled for an unregistered pack id (no throw, no persist)', async () => {
    const service = createPackService(makeRegistry())
    await service.setEnabled('never-registered', false)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [])
  })

  it('getPackService() installs a singleton registry with the first-party packs', () => {
    const service = getPackService()
    assert.equal(typeof service.registry.all, 'function')
    assert.ok(service.registry.all().length >= 1)
    // Second call returns the same singleton — critical so the IPC layer + the
    // hook-registry provider read through the same instance.
    assert.equal(getPackService(), service)
  })

  it('migrates P5 defaults without enabling the previously opt-in comparison tool', () => {
    // Isolate P5: sibling pack migrations run in the same getPackService()
    // call, so mark them already-done to keep this assertion scoped to the P5
    // packs (their own coverage lives in the blocks below).
    storageSet(LONG_HORIZON_TASKS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ROADMAP_PLANS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ADVISOR_STRATEGY_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(OKF_MEMORIES_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(CI_INVESTIGATOR_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(PII_REDACTION_ENABLEMENT_MIGRATION_KEY, true)
    const service = getPackService()

    assert.equal(service.registry.isEnabled(POST_TURN_REVIEW_PACK_ID), true)
    assert.equal(service.registry.isEnabled(MODEL_COMPARISON_PACK_ID), false)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [MODEL_COMPARISON_PACK_ID])
    assert.equal(storageGet(P5_ENABLEMENT_MIGRATION_KEY), true)
  })

  it('preserves explicit legacy P5 enablement choices', () => {
    storageSet(LONG_HORIZON_TASKS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ROADMAP_PLANS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ADVISOR_STRATEGY_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(OKF_MEMORIES_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(CI_INVESTIGATOR_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(PII_REDACTION_ENABLEMENT_MIGRATION_KEY, true)
    storageSet('postTurnReviewEnabled', false)
    storageSet('modelComparisonEnabled', true)

    const service = getPackService()

    assert.equal(service.registry.isEnabled(POST_TURN_REVIEW_PACK_ID), false)
    assert.equal(service.registry.isEnabled(MODEL_COMPARISON_PACK_ID), true)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [POST_TURN_REVIEW_PACK_ID])
  })

  it('does not overwrite pack choices after the P5 migration has run', () => {
    storageSet(P5_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(LONG_HORIZON_TASKS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ROADMAP_PLANS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ADVISOR_STRATEGY_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(OKF_MEMORIES_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(CI_INVESTIGATOR_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(PII_REDACTION_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(PACK_DISABLED_KEY, [POST_TURN_REVIEW_PACK_ID])
    storageSet('postTurnReviewEnabled', true)
    storageSet('modelComparisonEnabled', false)

    const service = getPackService()

    assert.equal(service.registry.isEnabled(POST_TURN_REVIEW_PACK_ID), false)
    assert.equal(service.registry.isEnabled(MODEL_COMPARISON_PACK_ID), true)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [POST_TURN_REVIEW_PACK_ID])
  })

  it('migrates long-horizon-tasks default-OFF without enabling the previously opt-in tool', () => {
    // Isolate from P5 + roadmap-plans + advisor-strategy + okf-memories (all run in getPackService).
    storageSet(P5_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ROADMAP_PLANS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ADVISOR_STRATEGY_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(OKF_MEMORIES_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(CI_INVESTIGATOR_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(PII_REDACTION_ENABLEMENT_MIGRATION_KEY, true)
    const service = getPackService()

    assert.equal(service.registry.isEnabled(LONG_HORIZON_TASKS_PACK_ID), false)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [LONG_HORIZON_TASKS_PACK_ID])
    assert.equal(storageGet(LONG_HORIZON_TASKS_ENABLEMENT_MIGRATION_KEY), true)
  })

  it('preserves an explicit legacy longHorizonTasksEnabled=true choice', () => {
    storageSet(P5_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ROADMAP_PLANS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ADVISOR_STRATEGY_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(OKF_MEMORIES_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(CI_INVESTIGATOR_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(PII_REDACTION_ENABLEMENT_MIGRATION_KEY, true)
    storageSet('longHorizonTasksEnabled', true)

    const service = getPackService()

    assert.equal(service.registry.isEnabled(LONG_HORIZON_TASKS_PACK_ID), true)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [])
  })

  it('does not overwrite pack choices after the long-horizon migration has run', () => {
    storageSet(P5_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(LONG_HORIZON_TASKS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ROADMAP_PLANS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ADVISOR_STRATEGY_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(OKF_MEMORIES_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(CI_INVESTIGATOR_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(PII_REDACTION_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(PACK_DISABLED_KEY, [])
    // A stale legacy value must be ignored once the migration key is set.
    storageSet('longHorizonTasksEnabled', false)

    const service = getPackService()

    assert.equal(service.registry.isEnabled(LONG_HORIZON_TASKS_PACK_ID), true)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [])
  })

  it('migrates roadmap-plans default-OFF without enabling the previously opt-in tool', () => {
    // Isolate from P5 + long-horizon-tasks + advisor-strategy + okf-memories (all run in getPackService).
    storageSet(P5_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(LONG_HORIZON_TASKS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ADVISOR_STRATEGY_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(OKF_MEMORIES_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(CI_INVESTIGATOR_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(PII_REDACTION_ENABLEMENT_MIGRATION_KEY, true)
    const service = getPackService()

    assert.equal(service.registry.isEnabled(ROADMAP_PLANS_PACK_ID), false)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [ROADMAP_PLANS_PACK_ID])
    assert.equal(storageGet(ROADMAP_PLANS_ENABLEMENT_MIGRATION_KEY), true)
  })

  it('preserves an explicit legacy roadmapPlansEnabled=true choice', () => {
    storageSet(P5_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(LONG_HORIZON_TASKS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ADVISOR_STRATEGY_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(OKF_MEMORIES_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(CI_INVESTIGATOR_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(PII_REDACTION_ENABLEMENT_MIGRATION_KEY, true)
    storageSet('roadmapPlansEnabled', true)

    const service = getPackService()

    assert.equal(service.registry.isEnabled(ROADMAP_PLANS_PACK_ID), true)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [])
  })

  it('does not overwrite pack choices after the roadmap migration has run', () => {
    storageSet(P5_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(LONG_HORIZON_TASKS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ROADMAP_PLANS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ADVISOR_STRATEGY_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(OKF_MEMORIES_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(CI_INVESTIGATOR_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(PII_REDACTION_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(PACK_DISABLED_KEY, [])
    // A stale legacy value must be ignored once the migration key is set.
    storageSet('roadmapPlansEnabled', false)

    const service = getPackService()

    assert.equal(service.registry.isEnabled(ROADMAP_PLANS_PACK_ID), true)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [])
  })

  it('migrates advisor-strategy default-OFF without enabling the previously opt-in tool', () => {
    // Isolate the advisor migration from sibling migrations (all run in
    // getPackService).
    storageSet(P5_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(LONG_HORIZON_TASKS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ROADMAP_PLANS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(OKF_MEMORIES_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(CI_INVESTIGATOR_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(PII_REDACTION_ENABLEMENT_MIGRATION_KEY, true)
    const service = getPackService()

    assert.equal(service.registry.isEnabled(ADVISOR_STRATEGY_PACK_ID), false)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [ADVISOR_STRATEGY_PACK_ID])
    assert.equal(storageGet(ADVISOR_STRATEGY_ENABLEMENT_MIGRATION_KEY), true)
  })

  it('preserves an explicit legacy advisorStrategyEnabled=true choice', () => {
    storageSet(P5_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(LONG_HORIZON_TASKS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ROADMAP_PLANS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(OKF_MEMORIES_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(CI_INVESTIGATOR_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(PII_REDACTION_ENABLEMENT_MIGRATION_KEY, true)
    storageSet('advisorStrategyEnabled', true)

    const service = getPackService()

    assert.equal(service.registry.isEnabled(ADVISOR_STRATEGY_PACK_ID), true)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [])
  })

  it('does not overwrite pack choices after the advisor migration has run', () => {
    storageSet(P5_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(LONG_HORIZON_TASKS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ROADMAP_PLANS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ADVISOR_STRATEGY_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(OKF_MEMORIES_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(CI_INVESTIGATOR_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(PII_REDACTION_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(PACK_DISABLED_KEY, [])
    // A stale legacy value must be ignored once the migration key is set.
    storageSet('advisorStrategyEnabled', false)

    const service = getPackService()

    assert.equal(service.registry.isEnabled(ADVISOR_STRATEGY_PACK_ID), true)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [])
  })

  it('migrates OKF memories default-OFF without enabling the previously opt-in tools', () => {
    // Isolate from P5 + long-horizon-tasks + roadmap-plans + advisor-strategy
    // (all run in getPackService).
    storageSet(P5_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(LONG_HORIZON_TASKS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ROADMAP_PLANS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ADVISOR_STRATEGY_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(CI_INVESTIGATOR_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(PII_REDACTION_ENABLEMENT_MIGRATION_KEY, true)
    const service = getPackService()

    assert.equal(service.registry.isEnabled(OKF_MEMORIES_PACK_ID), false)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [OKF_MEMORIES_PACK_ID])
    assert.equal(storageGet(OKF_MEMORIES_ENABLEMENT_MIGRATION_KEY), true)
  })

  it('preserves an explicit legacy okfMemoriesEnabled=true choice', () => {
    storageSet(P5_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(LONG_HORIZON_TASKS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ROADMAP_PLANS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ADVISOR_STRATEGY_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(CI_INVESTIGATOR_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(PII_REDACTION_ENABLEMENT_MIGRATION_KEY, true)
    storageSet('okfMemoriesEnabled', true)

    const service = getPackService()

    assert.equal(service.registry.isEnabled(OKF_MEMORIES_PACK_ID), true)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [])
  })

  it('does not overwrite pack choices after the OKF-memories migration has run', () => {
    storageSet(P5_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(LONG_HORIZON_TASKS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ROADMAP_PLANS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ADVISOR_STRATEGY_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(OKF_MEMORIES_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(CI_INVESTIGATOR_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(PII_REDACTION_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(PACK_DISABLED_KEY, [])
    // A stale legacy value must be ignored once the migration key is set.
    storageSet('okfMemoriesEnabled', false)

    const service = getPackService()

    assert.equal(service.registry.isEnabled(OKF_MEMORIES_PACK_ID), true)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [])
  })

  it('migrates ci-investigator default-OFF without enabling the previously opt-in tool', () => {
    // Isolate the CI-investigator migration from sibling migrations.
    storageSet(P5_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(LONG_HORIZON_TASKS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ROADMAP_PLANS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ADVISOR_STRATEGY_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(OKF_MEMORIES_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(PII_REDACTION_ENABLEMENT_MIGRATION_KEY, true)
    const service = getPackService()

    assert.equal(service.registry.isEnabled(CI_INVESTIGATOR_PACK_ID), false)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [CI_INVESTIGATOR_PACK_ID])
    assert.equal(storageGet(CI_INVESTIGATOR_ENABLEMENT_MIGRATION_KEY), true)
  })

  it('preserves an explicit legacy ciInvestigatorEnabled=true choice', () => {
    storageSet(P5_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(LONG_HORIZON_TASKS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ROADMAP_PLANS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ADVISOR_STRATEGY_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(OKF_MEMORIES_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(PII_REDACTION_ENABLEMENT_MIGRATION_KEY, true)
    storageSet('ciInvestigatorEnabled', true)

    const service = getPackService()

    assert.equal(service.registry.isEnabled(CI_INVESTIGATOR_PACK_ID), true)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [])
  })

  it('does not overwrite pack choices after the CI-investigator migration has run', () => {
    storageSet(P5_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(LONG_HORIZON_TASKS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ROADMAP_PLANS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ADVISOR_STRATEGY_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(OKF_MEMORIES_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(CI_INVESTIGATOR_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(PII_REDACTION_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(PACK_DISABLED_KEY, [])
    // A stale legacy value must be ignored once the migration key is set.
    storageSet('ciInvestigatorEnabled', false)

    const service = getPackService()

    assert.equal(service.registry.isEnabled(CI_INVESTIGATOR_PACK_ID), true)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [])
  })

  it('migrates PII redaction default-OFF without enabling the previously opt-in tool', () => {
    // Isolate from sibling migrations (all run in getPackService).
    storageSet(P5_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(LONG_HORIZON_TASKS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ROADMAP_PLANS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ADVISOR_STRATEGY_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(OKF_MEMORIES_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(CI_INVESTIGATOR_ENABLEMENT_MIGRATION_KEY, true)
    const service = getPackService()

    assert.equal(service.registry.isEnabled(PII_REDACTION_PACK_ID), false)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [PII_REDACTION_PACK_ID])
    assert.equal(storageGet(PII_REDACTION_ENABLEMENT_MIGRATION_KEY), true)
  })

  it('preserves an explicit legacy piiRedactionEnabled=true choice', () => {
    storageSet(P5_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(LONG_HORIZON_TASKS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ROADMAP_PLANS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ADVISOR_STRATEGY_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(OKF_MEMORIES_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(CI_INVESTIGATOR_ENABLEMENT_MIGRATION_KEY, true)
    storageSet('piiRedactionEnabled', true)

    const service = getPackService()

    assert.equal(service.registry.isEnabled(PII_REDACTION_PACK_ID), true)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [])
  })

  it('does not overwrite pack choices after the PII migration has run', () => {
    storageSet(P5_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(LONG_HORIZON_TASKS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ROADMAP_PLANS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ADVISOR_STRATEGY_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(OKF_MEMORIES_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(CI_INVESTIGATOR_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(PII_REDACTION_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(PACK_DISABLED_KEY, [])
    // A stale legacy value must be ignored once the migration key is set.
    storageSet('piiRedactionEnabled', false)

    const service = getPackService()

    assert.equal(service.registry.isEnabled(PII_REDACTION_PACK_ID), true)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [])
  })

  /**
   * Mark every migration except the one under test as already-done, so a single
   * getPackService() run exercises just that capability-pack migration. The two
   * capability keys + the background-tasks key are marked done by clearStorage in
   * beforeEach, so the test only clears its own target.
   */
  function isolateSiblingMigrations(): void {
    storageSet(P5_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(LONG_HORIZON_TASKS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ROADMAP_PLANS_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(ADVISOR_STRATEGY_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(OKF_MEMORIES_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(CI_INVESTIGATOR_ENABLEMENT_MIGRATION_KEY, true)
    storageSet(PII_REDACTION_ENABLEMENT_MIGRATION_KEY, true)
  }

  it('migrates mcp-ui-canvas default-OFF without silently enabling canvas', () => {
    isolateSiblingMigrations()
    storageDelete(MCP_UI_CANVAS_ENABLEMENT_MIGRATION_KEY)
    const service = getPackService()

    assert.equal(service.registry.isEnabled(MCP_UI_CANVAS_PACK_ID), false)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [MCP_UI_CANVAS_PACK_ID])
    assert.equal(storageGet(MCP_UI_CANVAS_ENABLEMENT_MIGRATION_KEY), true)
  })

  it('preserves an explicit legacy mcpUiArtefactsEnabled=true choice', () => {
    isolateSiblingMigrations()
    storageDelete(MCP_UI_CANVAS_ENABLEMENT_MIGRATION_KEY)
    storageSet('mcpUiArtefactsEnabled', true)

    const service = getPackService()

    assert.equal(service.registry.isEnabled(MCP_UI_CANVAS_PACK_ID), true)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [])
  })

  it('migrates devtools-shortcut default-OFF without silently registering the shortcut', () => {
    isolateSiblingMigrations()
    storageDelete(DEVTOOLS_SHORTCUT_ENABLEMENT_MIGRATION_KEY)
    const service = getPackService()

    assert.equal(service.registry.isEnabled(DEVTOOLS_SHORTCUT_PACK_ID), false)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [DEVTOOLS_SHORTCUT_PACK_ID])
    assert.equal(storageGet(DEVTOOLS_SHORTCUT_ENABLEMENT_MIGRATION_KEY), true)
  })

  it('preserves an explicit legacy devtoolsShortcutEnabled=true choice', () => {
    isolateSiblingMigrations()
    storageDelete(DEVTOOLS_SHORTCUT_ENABLEMENT_MIGRATION_KEY)
    storageSet('devtoolsShortcutEnabled', true)

    const service = getPackService()

    assert.equal(service.registry.isEnabled(DEVTOOLS_SHORTCUT_PACK_ID), true)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [])
  })

  it('migrates background-tasks default-OFF without silently enabling run_background', () => {
    isolateSiblingMigrations()
    storageDelete(BACKGROUND_TASKS_ENABLEMENT_MIGRATION_KEY)
    const service = getPackService()

    assert.equal(service.registry.isEnabled(BACKGROUND_TASKS_PACK_ID), false)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [BACKGROUND_TASKS_PACK_ID])
    assert.equal(storageGet(BACKGROUND_TASKS_ENABLEMENT_MIGRATION_KEY), true)
  })

  it('preserves an explicit legacy backgroundTasksEnabled=true choice', () => {
    isolateSiblingMigrations()
    storageDelete(BACKGROUND_TASKS_ENABLEMENT_MIGRATION_KEY)
    storageSet('backgroundTasksEnabled', true)

    const service = getPackService()

    assert.equal(service.registry.isEnabled(BACKGROUND_TASKS_PACK_ID), true)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [])
  })

  it('does not overwrite pack choices after the background-tasks migration has run', () => {
    isolateSiblingMigrations()
    // The migration key is already set by clearStorage → beforeEach.
    storageSet(PACK_DISABLED_KEY, [])
    // A stale legacy value must be ignored once the migration key is set.
    storageSet('backgroundTasksEnabled', false)

    const service = getPackService()

    assert.equal(service.registry.isEnabled(BACKGROUND_TASKS_PACK_ID), true)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [])
  })
})
