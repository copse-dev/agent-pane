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
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { MCP_UI_CANVAS_PACK_ID } from '@copse/agent/packs/mcp-ui-canvas-pack.ts'
import { DEVTOOLS_SHORTCUT_PACK_ID } from '@copse/agent/packs/devtools-shortcut-pack.ts'
import { BACKGROUND_TASKS_PACK_ID } from '@copse/agent/packs/background-tasks-pack.ts'
import { parseStringList } from '../storage/storage-schema.ts'
import { AUTOMATIONS_PACK_ID } from '@copse/agent/packs/automations-pack.ts'
import { storageDelete, storageGet, storageSet } from '../storage/storage.ts'
import { __resetPackServiceForTests, createPackService, getPackService } from './pack-service.ts'
import {
  setPackToolRuntimeController,
  type PackToolRuntimeController,
} from './pack-tool-controller.ts'

const PACK_DISABLED_KEY = 'packDisabled'
const AUTOMATIONS_ENABLEMENT_MIGRATION_KEY = 'packMigration.automationsEnablement'
const PACK_SOURCES_KEY = 'packSources'
const packSettingsKey = (id: string): string => `pack.${id}.settings`
const localPackRoots: string[] = []

async function makeToolPack(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'copse-pack-service-local-'))
  localPackRoots.push(root)
  await mkdir(join(root, 'dist'))
  await writeFile(join(root, 'dist', 'index.mjs'), 'export default {}\n')
  await writeFile(
    join(root, 'copse-pack.json'),
    JSON.stringify({
      name: 'personal.local-tools',
      tools: {
        provides: ['personal_judge'],
        runtime: { entrypoint: 'dist/index.mjs', apiVersion: 1 },
      },
    }),
  )
  return root
}

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
  // Keep the prototype's one-time default-off migration out of unrelated cases;
  // its dedicated test below deletes this marker explicitly.
  storageSet(AUTOMATIONS_ENABLEMENT_MIGRATION_KEY, true)
  storageSet(PACK_SOURCES_KEY, [])
  storageSet(packSettingsKey('demo.pack'), {})
  storageSet(packSettingsKey('copse.other'), {})
}

describe('PackService', () => {
  beforeEach(() => {
    __resetPackServiceForTests()
    clearStorage()
  })

  afterEach(async () => {
    __resetPackServiceForTests()
    await Promise.all(
      localPackRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    )
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

  it('discovers selected tool packs as ordinary user packs and refreshes their hash', async () => {
    const registry = makeRegistry()
    const service = createPackService(registry)
    const source = await makeToolPack()

    await service.addPackSource(source)
    const discovered = service.list().find((pack) => pack.id === 'personal.local-tools')
    assert.ok(discovered)
    assert.equal(discovered.trust, 'user')
    assert.equal(discovered.enabled, false)
    assert.ok(discovered.source)
    assert.equal(discovered.source.path, await realpath(source))
    assert.match(discovered.source.contentHash, /^sha256:[a-f0-9]{64}$/)
    assert.deepEqual(discovered.contributions.toolNames, ['personal_judge'])
    assert.equal(registry.activeToolNames().includes('personal_judge'), false)
    assert.equal(parseStringList(storageGet(PACK_DISABLED_KEY)).includes(discovered.id), false)

    await writeFile(join(source, 'dist', 'index.mjs'), 'export default { changed: true }\n')
    await service.refreshPackSources()
    const changed = service.list().find((pack) => pack.id === 'personal.local-tools')
    assert.ok(changed)
    assert.ok(changed.source)
    assert.notEqual(changed.source.contentHash, discovered.source.contentHash)
  })

  it('starts selected tool behavior on add and stops it before disabling the pack', async () => {
    const calls: string[] = []
    let running = false
    const controller: PackToolRuntimeController = {
      enable(candidate) {
        calls.push(`enable:${candidate.manifest.name}`)
        running = true
        return Promise.resolve()
      },
      disable(packId) {
        calls.push(`disable:${packId}`)
        running = false
        return Promise.resolve()
      },
      isRunning: () => running,
      registrations: () => null,
      invoke: () => Promise.resolve(null),
    }
    setPackToolRuntimeController(controller)
    const registry = makeRegistry()
    const service = createPackService(registry)
    await service.addPackSource(await makeToolPack())
    const pack = service.list().find((candidate) => candidate.id === 'personal.local-tools')
    assert.ok(pack?.source)
    assert.equal(registry.isEnabled(pack.id), true)
    assert.equal(parseStringList(storageGet(PACK_DISABLED_KEY)).includes(pack.id), false)

    await service.setEnabled(pack.id, false)
    assert.equal(registry.isEnabled(pack.id), false)
    assert.deepEqual(calls, [`enable:${pack.id}`, `disable:${pack.id}`])
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
      // Added with the contribution kinds (#1188-#1190); each replaces a retired
      // opt-in boolean, so each must ship off like its predecessor.
      MCP_UI_CANVAS_PACK_ID,
      DEVTOOLS_SHORTCUT_PACK_ID,
      BACKGROUND_TASKS_PACK_ID,
      AUTOMATIONS_PACK_ID,
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
        MCP_UI_CANVAS_PACK_ID,
        DEVTOOLS_SHORTCUT_PACK_ID,
        BACKGROUND_TASKS_PACK_ID,
        AUTOMATIONS_PACK_ID,
      ].sort(),
    )
  })

  it('seeds the new automations pack disabled without erasing later choices', async () => {
    storageDelete(AUTOMATIONS_ENABLEMENT_MIGRATION_KEY)
    const service = getPackService()
    assert.equal(service.registry.isEnabled(AUTOMATIONS_PACK_ID), false)
    const disabled = storageGet(PACK_DISABLED_KEY)
    assert.ok(Array.isArray(disabled))
    assert.ok(disabled.includes(AUTOMATIONS_PACK_ID))
    assert.equal(storageGet(AUTOMATIONS_ENABLEMENT_MIGRATION_KEY), true)

    await service.setEnabled(AUTOMATIONS_PACK_ID, true)
    __resetPackServiceForTests()
    const later = getPackService()
    assert.equal(later.registry.isEnabled(AUTOMATIONS_PACK_ID), true)
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
      AUTOMATIONS_PACK_ID,
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
