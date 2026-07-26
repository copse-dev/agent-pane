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
import {
  COMPARISON_JUDGE_MODEL_SETTING_ID,
  COMPARISON_MODEL_A_SETTING_ID,
  COMPARISON_MODEL_B_SETTING_ID,
  MODEL_COMPARISON_PACK_ID,
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
import { TODOS_PACK_ID } from '@copse/agent/packs/todos-pack.ts'
import { createFirstPartyPackRegistry } from '@copse/agent/packs/first-party-packs.ts'
import { storageDelete, storageGet, storageSet } from '../storage/storage.ts'
import { setSetting } from '../storage/settings.ts'
import { __resetPackServiceForTests, createPackService, getPackService } from './pack-service.ts'

const PACK_ENABLEMENT_KEY = 'packEnablement'
const LEGACY_PACK_DISABLED_KEY = 'packDisabled'
const PACK_MODEL_SETTINGS_MIGRATION_KEY = 'packMigration.packModelSettings'
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
  storageDelete(PACK_ENABLEMENT_KEY)
  storageDelete(LEGACY_PACK_DISABLED_KEY)
  // The model-settings lift is the one migration left; mark it done by default
  // so the enablement tests are not perturbed by it. Its own tests clear the key.
  storageSet(PACK_MODEL_SETTINGS_MIGRATION_KEY, true)
  storageDelete(packSettingsKey(ADVISOR_STRATEGY_PACK_ID))
  storageDelete(packSettingsKey(MODEL_COMPARISON_PACK_ID))
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
    assert.deepEqual(storageGet(PACK_ENABLEMENT_KEY), { 'demo.pack': false })

    // Persisted on disk: a fresh registry + service pair inherits the disable.
    const laterRegistry = makeRegistry()
    createPackService(laterRegistry)
    assert.equal(laterRegistry.isEnabled('demo.pack'), false)
  })

  it('re-enabling records an explicit true rather than dropping the entry', async () => {
    const registry = makeRegistry()
    const service = createPackService(registry)

    await service.setEnabled('demo.pack', false)
    await service.setEnabled('demo.pack', true)
    assert.equal(registry.isEnabled('demo.pack'), true)
    // `true` is persisted, not erased: for a `defaultEnabled: false` pack this
    // is the only representation of "the user opted in".
    assert.deepEqual(storageGet(PACK_ENABLEMENT_KEY), { 'demo.pack': true })
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
    assert.equal(storageGet(PACK_ENABLEMENT_KEY), undefined)
  })

  it('getPackService() installs a singleton registry with the first-party packs', () => {
    const service = getPackService()
    assert.equal(typeof service.registry.all, 'function')
    assert.ok(service.registry.all().length >= 1)
    // Second call returns the same singleton — critical so the IPC layer + the
    // hook-registry provider read through the same instance.
    assert.equal(getPackService(), service)
  })

  // --- Declared defaults replace the enablement migrations -------------------
  //
  // Every experimental pack used to be forced off by its own one-shot
  // `migrate*Enablement()`. Those are gone: the default is declared on the
  // manifest, so it holds for a fresh install, for an upgrade, and — crucially —
  // for a registry nobody wired up. These tests pin the resulting defaults so a
  // pack cannot quietly start shipping on.

  it('ships every experimental first-party pack disabled by default', () => {
    const service = getPackService()
    const off = [
      MODEL_COMPARISON_PACK_ID,
      LONG_HORIZON_TASKS_PACK_ID,
      ROADMAP_PLANS_PACK_ID,
      ADVISOR_STRATEGY_PACK_ID,
      OKF_MEMORIES_PACK_ID,
      CI_INVESTIGATOR_PACK_ID,
      PII_REDACTION_PACK_ID,
      MCP_UI_CANVAS_PACK_ID,
      DEVTOOLS_SHORTCUT_PACK_ID,
      BACKGROUND_TASKS_PACK_ID,
    ]
    for (const id of off) {
      assert.equal(service.registry.isEnabled(id), false, `${id} must ship disabled`)
    }
    // Nothing is written for a user who never touched a toggle — the default is
    // read from the manifest every boot rather than baked into storage.
    assert.equal(storageGet(PACK_ENABLEMENT_KEY), undefined)
  })

  it('keeps the on-by-default packs on', () => {
    const service = getPackService()
    assert.equal(service.registry.isEnabled(POST_TURN_REVIEW_PACK_ID), true)
    assert.equal(service.registry.isEnabled(TODOS_PACK_ID), true)
  })

  // The reason default-off moved onto the manifest: `getDefaultPackRegistry()`
  // hands out a fresh first-party registry when the host has not installed one
  // yet. That fallback used to report every pack enabled, so a read site running
  // before boot finished saw canvas on, the DevTools shortcut on, and — worst —
  // `isPermissionDeclared('loopback-bind')` answering "granted".
  it('reports default-off packs as disabled even in an unwired fallback registry', () => {
    const unwired = createFirstPartyPackRegistry()
    assert.equal(unwired.isEnabled(BACKGROUND_TASKS_PACK_ID), false)
    assert.equal(unwired.isPermissionDeclared('loopback-bind'), false)
    assert.equal(unwired.isCapabilityActive('mcp-ui-canvas'), false)
    assert.equal(unwired.isCapabilityActive('devtools-shortcut'), false)
  })

  it('lets an explicit opt-in survive a restart for a default-off pack', async () => {
    await getPackService().setEnabled(BACKGROUND_TASKS_PACK_ID, true)
    assert.deepEqual(storageGet(PACK_ENABLEMENT_KEY), { [BACKGROUND_TASKS_PACK_ID]: true })

    __resetPackServiceForTests()
    assert.equal(getPackService().registry.isEnabled(BACKGROUND_TASKS_PACK_ID), true)
  })

  it('lets an explicit opt-out survive a restart for a default-on pack', async () => {
    await getPackService().setEnabled(POST_TURN_REVIEW_PACK_ID, false)

    __resetPackServiceForTests()
    assert.equal(getPackService().registry.isEnabled(POST_TURN_REVIEW_PACK_ID), false)
  })

  // A user upgrading from the `packDisabled` array has expressed a real choice;
  // folding it in on read keeps it without a one-shot migration to guard.
  it('honours a legacy packDisabled array as an explicit disable', () => {
    storageSet(LEGACY_PACK_DISABLED_KEY, [POST_TURN_REVIEW_PACK_ID])

    assert.equal(getPackService().registry.isEnabled(POST_TURN_REVIEW_PACK_ID), false)
  })

  it('lets the explicit map win over a stale legacy packDisabled entry', () => {
    storageSet(LEGACY_PACK_DISABLED_KEY, [POST_TURN_REVIEW_PACK_ID])
    storageSet(PACK_ENABLEMENT_KEY, { [POST_TURN_REVIEW_PACK_ID]: true })

    assert.equal(getPackService().registry.isEnabled(POST_TURN_REVIEW_PACK_ID), true)
  })

  it('ignores a legacy disable for a pack that ships off anyway', () => {
    storageSet(LEGACY_PACK_DISABLED_KEY, [BACKGROUND_TASKS_PACK_ID])

    assert.equal(getPackService().registry.isEnabled(BACKGROUND_TASKS_PACK_ID), false)
  })

  it('lifts legacy settings.json model ids into pack settings bags', async () => {
    storageDelete(PACK_MODEL_SETTINGS_MIGRATION_KEY)
    // These model ids live in settings.json (getSetting), not config.json
    // (storageGet). A storageGet-only migration would leave every upgrade on the
    // pack defaults and break e2e seeds that write advisorModel via writeSettings.
    await setSetting('advisorModel', 'claude-haiku-4-5')
    await setSetting('comparisonModelA', 'claude-opus-4-8')
    await setSetting('comparisonModelB', 'claude-sonnet-4-6')
    await setSetting('comparisonJudgeModel', 'claude-fable-5')
    // Poison the wrong store so a regression to storageGet would fail loudly.
    storageSet('advisorModel', 'wrong-store-should-not-win')

    const service = getPackService()

    assert.deepEqual(storageGet(packSettingsKey(ADVISOR_STRATEGY_PACK_ID)), {
      [ADVISOR_MODEL_SETTING_ID]: 'claude-haiku-4-5',
    })
    assert.deepEqual(storageGet(packSettingsKey(MODEL_COMPARISON_PACK_ID)), {
      [COMPARISON_MODEL_A_SETTING_ID]: 'claude-opus-4-8',
      [COMPARISON_MODEL_B_SETTING_ID]: 'claude-sonnet-4-6',
      [COMPARISON_JUDGE_MODEL_SETTING_ID]: 'claude-fable-5',
    })
    assert.equal(
      service.getSetting(ADVISOR_STRATEGY_PACK_ID, ADVISOR_MODEL_SETTING_ID),
      'claude-haiku-4-5',
    )
    assert.equal(storageGet(PACK_MODEL_SETTINGS_MIGRATION_KEY), true)
  })

  it('does not clobber pack model settings already written before the lift', async () => {
    storageDelete(PACK_MODEL_SETTINGS_MIGRATION_KEY)
    storageSet(packSettingsKey(ADVISOR_STRATEGY_PACK_ID), {
      [ADVISOR_MODEL_SETTING_ID]: 'claude-fable-5',
    })
    await setSetting('advisorModel', 'claude-haiku-4-5')

    getPackService()

    assert.deepEqual(storageGet(packSettingsKey(ADVISOR_STRATEGY_PACK_ID)), {
      [ADVISOR_MODEL_SETTING_ID]: 'claude-fable-5',
    })
  })
})
