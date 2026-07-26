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
import { FORCED_PLANNING_PACK_ID } from '@copse/agent/packs/forced-planning-pack.ts'
import { parseStringList } from '../storage/storage-schema.ts'
import { storageDelete, storageGet, storageSet } from '../storage/storage.ts'
import { __resetPackServiceForTests, createPackService, getPackService } from './pack-service.ts'

const PACK_DISABLED_KEY = 'packDisabled'
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

  it('seeds the default-off packs on a profile that has no pack list', () => {
    storageDelete(PACK_DISABLED_KEY)

    const service = getPackService()

    // Post-turn review has always been on; every experimental pack starts off.
    assert.equal(service.registry.isEnabled(POST_TURN_REVIEW_PACK_ID), true)
    for (const id of [
      MODEL_COMPARISON_PACK_ID,
      LONG_HORIZON_TASKS_PACK_ID,
      ROADMAP_PLANS_PACK_ID,
      ADVISOR_STRATEGY_PACK_ID,
      OKF_MEMORIES_PACK_ID,
      CI_INVESTIGATOR_PACK_ID,
      PII_REDACTION_PACK_ID,
      FORCED_PLANNING_PACK_ID,
    ]) {
      assert.equal(service.registry.isEnabled(id), false, id)
    }
    assert.deepEqual(
      storageGet(PACK_DISABLED_KEY),
      [
        MODEL_COMPARISON_PACK_ID,
        LONG_HORIZON_TASKS_PACK_ID,
        ROADMAP_PLANS_PACK_ID,
        ADVISOR_STRATEGY_PACK_ID,
        OKF_MEMORIES_PACK_ID,
        CI_INVESTIGATOR_PACK_ID,
        PII_REDACTION_PACK_ID,
        FORCED_PLANNING_PACK_ID,
      ].sort(),
    )
  })

  it('never re-seeds over a pack list the user already owns', () => {
    // Everything default-off except model comparison, which the user enabled.
    storageSet(PACK_DISABLED_KEY, [
      LONG_HORIZON_TASKS_PACK_ID,
      ROADMAP_PLANS_PACK_ID,
      ADVISOR_STRATEGY_PACK_ID,
      OKF_MEMORIES_PACK_ID,
      CI_INVESTIGATOR_PACK_ID,
      PII_REDACTION_PACK_ID,
    ])

    const service = getPackService()

    assert.equal(service.registry.isEnabled(MODEL_COMPARISON_PACK_ID), true)
    assert.equal(service.registry.isEnabled(PII_REDACTION_PACK_ID), false)
    assert.equal(
      parseStringList(storageGet(PACK_DISABLED_KEY)).includes(MODEL_COMPARISON_PACK_ID),
      false,
    )
  })

  it('treats an empty pack list as the user turning everything on', () => {
    storageSet(PACK_DISABLED_KEY, [])

    const service = getPackService()

    assert.equal(service.registry.isEnabled(PII_REDACTION_PACK_ID), true)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [])
  })

  it('never re-disables forced planning once the user has enabled it', () => {
    // The pack rewrites the system prompt of every turn on a below-threshold
    // model, so it is in the default-off set — but only as a *seed*. A list the
    // user owns wins, including one that leaves forced planning on.
    storageSet(PACK_DISABLED_KEY, [PII_REDACTION_PACK_ID])

    const service = getPackService()

    assert.equal(service.registry.isEnabled(FORCED_PLANNING_PACK_ID), true)
    assert.deepEqual(storageGet(PACK_DISABLED_KEY), [PII_REDACTION_PACK_ID])
  })
})
