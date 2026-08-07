// PluginService — P3 host wiring (docs/plans/hooks-and-feature-packs.md).
//
// Pins the invariants the Settings plugin list depends on:
//  - `setEnabled(false)` flips the shared registry's flag AND persists to
//    `electron-store`, so the loop sees the disable immediately (atomic — P1
//    contract) and the toggle survives relaunch.
//  - Plugin settings persist under a plugin-scoped bag, keyed by field id.
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
import { PluginRegistry } from '@copse/agent/plugins/plugin-registry.ts'
import { definePlugin } from '@copse/agent/plugins/plugin-manifest.ts'
import { MODEL_COMPARISON_PLUGIN_ID } from '@copse/agent/plugins/model-comparison-plugin.ts'
import { POST_TURN_REVIEW_PLUGIN_ID } from '@copse/agent/plugins/post-turn-review-plugin.ts'
import { LONG_HORIZON_TASKS_PLUGIN_ID } from '@copse/agent/plugins/long-horizon-tasks-plugin.ts'
import { ROADMAP_PLANS_PLUGIN_ID } from '@copse/agent/plugins/roadmap-plans-plugin.ts'
import { ADVISOR_STRATEGY_PLUGIN_ID } from '@copse/agent/plugins/advisor-strategy-plugin.ts'
import { OKF_MEMORIES_PLUGIN_ID } from '@copse/agent/plugins/okf-memories-plugin.ts'
import { CI_INVESTIGATOR_PLUGIN_ID } from '@copse/agent/plugins/ci-investigator-plugin.ts'
import { PII_REDACTION_PLUGIN_ID } from '@copse/agent/plugins/pii-redaction-plugin.ts'
import { FORCED_PLANNING_PLUGIN_ID } from '@copse/agent/plugins/forced-planning-plugin.ts'
import { MCP_UI_CANVAS_PLUGIN_ID } from '@copse/agent/plugins/mcp-ui-canvas-plugin.ts'
import { DEVTOOLS_SHORTCUT_PLUGIN_ID } from '@copse/agent/plugins/devtools-shortcut-plugin.ts'
import { BACKGROUND_TASKS_PLUGIN_ID } from '@copse/agent/plugins/background-tasks-plugin.ts'
import { parseStringList } from '../storage/storage-schema.ts'
import { AUTOMATIONS_PLUGIN_ID } from '@copse/agent/plugins/automations-plugin.ts'
import { DARK_FACTORY_PLUGIN_ID } from '@copse/agent/plugins/dark-factory-plugin.ts'
import { PARALLEL_SEARCH_PLUGIN_ID } from '@copse/agent/plugins/parallel-search-plugin.ts'
import { storageDelete, storageGet, storageSet } from '../storage/storage.ts'
import {
  __resetPluginServiceForTests,
  createPluginService,
  getPluginService,
} from './plugin-service.ts'
import {
  setPluginToolRuntimeController,
  type PluginToolRuntimeController,
} from './plugin-tool-controller.ts'

const PLUGIN_DISABLED_KEY = 'pluginDisabled'
const AUTOMATIONS_ENABLEMENT_MIGRATION_KEY = 'pluginMigration.automationsEnablement'
const PARALLEL_SEARCH_ENABLEMENT_MIGRATION_KEY = 'pluginMigration.parallelSearchEnablement'
const PLUGIN_SOURCES_KEY = 'pluginSources'
const pluginSettingsKey = (id: string): string => `plugin.${id}.settings`
const localPluginRoots: string[] = []

async function makeToolPlugin(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'copse-plugin-service-local-'))
  localPluginRoots.push(root)
  await mkdir(join(root, 'dist'))
  await writeFile(join(root, 'dist', 'index.mjs'), 'export default {}\n')
  await writeFile(
    join(root, 'copse-plugin.json'),
    JSON.stringify({
      name: 'personal.local-tools',
      tools: {
        provides: ['personal_judge'],
      },
      runtime: { entrypoint: 'dist/index.mjs', apiVersion: 1 },
    }),
  )
  return root
}

function makeRegistry(): PluginRegistry {
  const registry = new PluginRegistry()
  registry.register(
    definePlugin(
      {
        name: 'demo.plugin',
        trust: 'first-party',
        stability: 'stable',
        description: 'demo plugin',
        storage: { namespace: 'demo.plugin' },
        settings: {
          budget: { kind: 'number', title: 'Budget', default: 3 },
          label: { kind: 'string', title: 'Label', default: 'hi' },
        },
      },
      { toolNames: ['demo_tool'] },
    ),
  )
  registry.register(
    definePlugin({
      name: 'copse.other',
      trust: 'first-party',
      stability: 'stable',
      storage: { namespace: 'copse.other' },
    }),
  )
  return registry
}

function clearStorage(): void {
  storageSet(PLUGIN_DISABLED_KEY, [])
  // Keep the prototype's one-time default-off migration out of unrelated cases;
  // its dedicated test below deletes this marker explicitly.
  storageSet(AUTOMATIONS_ENABLEMENT_MIGRATION_KEY, true)
  storageSet(PARALLEL_SEARCH_ENABLEMENT_MIGRATION_KEY, true)
  storageSet(PLUGIN_SOURCES_KEY, [])
  storageSet(pluginSettingsKey('demo.plugin'), {})
  storageSet(pluginSettingsKey('copse.other'), {})
}

describe('PluginService', () => {
  beforeEach(() => {
    __resetPluginServiceForTests()
    clearStorage()
  })

  afterEach(async () => {
    __resetPluginServiceForTests()
    await Promise.all(
      localPluginRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    )
  })

  it('lists every registered plugin with its enablement + settings values', () => {
    const service = createPluginService(makeRegistry())
    const plugins = service.list()
    assert.deepEqual(
      plugins.map((p) => p.id),
      ['demo.plugin', 'copse.other'],
    )
    const demo = plugins.find((p) => p.id === 'demo.plugin')
    assert.ok(demo)
    assert.equal(demo.enabled, true)
    const byId = Object.fromEntries(demo.settings.map((f) => [f.id, f.value]))
    assert.deepEqual(byId, { budget: 3, label: 'hi' })
  })

  it('setEnabled(false) flips the shared registry flag and persists to storage', async () => {
    const registry = makeRegistry()
    const service = createPluginService(registry)

    await service.setEnabled('demo.plugin', false)
    assert.equal(registry.isEnabled('demo.plugin'), false)
    // The loop reading through the registry sees the disable immediately —
    // atomic per the P1 contract.
    assert.deepEqual(registry.activeToolNames(), [])
    assert.deepEqual(storageGet(PLUGIN_DISABLED_KEY), ['demo.plugin'])

    // Persisted on disk: a fresh registry + service pair inherits the disable.
    const laterRegistry = makeRegistry()
    createPluginService(laterRegistry)
    assert.equal(laterRegistry.isEnabled('demo.plugin'), false)
  })

  it('re-enabling drops the id from the persisted disable list', async () => {
    const registry = makeRegistry()
    const service = createPluginService(registry)

    await service.setEnabled('demo.plugin', false)
    await service.setEnabled('demo.plugin', true)
    assert.equal(registry.isEnabled('demo.plugin'), true)
    assert.deepEqual(storageGet(PLUGIN_DISABLED_KEY), [])
  })

  it('persists plugin-scoped settings under a namespaced key and reflects them in list()', async () => {
    const registry = makeRegistry()
    const service = createPluginService(registry)

    await service.setSetting('demo.plugin', 'budget', 7)
    await service.setSetting('demo.plugin', 'label', 'from-user')

    assert.deepEqual(storageGet(pluginSettingsKey('demo.plugin')), {
      budget: 7,
      label: 'from-user',
    })

    const plugins = service.list()
    const demo = plugins.find((p) => p.id === 'demo.plugin')
    assert.ok(demo)
    const byId = Object.fromEntries(demo.settings.map((f) => [f.id, f.value]))
    assert.deepEqual(byId, { budget: 7, label: 'from-user' })
  })

  it('rejects a setting key the plugin does not declare (P3 review)', async () => {
    const registry = makeRegistry()
    const service = createPluginService(registry)

    // The IPC caps the value size but not key legitimacy; without schema
    // validation any renderer bug could grow arbitrary keys in the bag forever.
    await assert.rejects(
      () => service.setSetting('demo.plugin', 'not-declared', 'x'),
      /declares no setting "not-declared"/,
    )
    await assert.rejects(() => service.setSetting('no-such-plugin', 'budget', 1))
    assert.deepEqual(storageGet(pluginSettingsKey('demo.plugin')) ?? {}, {}, 'nothing persisted')
  })

  it('ignores setEnabled for an unregistered plugin id (no throw, no persist)', async () => {
    const service = createPluginService(makeRegistry())
    await service.setEnabled('never-registered', false)
    assert.deepEqual(storageGet(PLUGIN_DISABLED_KEY), [])
  })

  it('discovers selected tool plugins as ordinary user plugins and refreshes their hash', async () => {
    const registry = makeRegistry()
    const service = createPluginService(registry)
    const source = await makeToolPlugin()

    await service.addPluginSource(source)
    const discovered = service.list().find((plugin) => plugin.id === 'personal.local-tools')
    assert.ok(discovered)
    assert.equal(discovered.trust, 'user')
    assert.equal(discovered.enabled, false)
    assert.ok(discovered.source)
    assert.equal(discovered.source.path, await realpath(source))
    assert.match(discovered.source.contentHash, /^sha256:[a-f0-9]{64}$/)
    assert.deepEqual(discovered.contributions.toolNames, ['personal_judge'])
    assert.equal(registry.activeToolNames().includes('personal_judge'), false)
    assert.equal(parseStringList(storageGet(PLUGIN_DISABLED_KEY)).includes(discovered.id), false)

    await writeFile(join(source, 'dist', 'index.mjs'), 'export default { changed: true }\n')
    await service.refreshPluginSources()
    const changed = service.list().find((plugin) => plugin.id === 'personal.local-tools')
    assert.ok(changed)
    assert.ok(changed.source)
    assert.notEqual(changed.source.contentHash, discovered.source.contentHash)
  })

  it('starts selected tool behavior on add and stops it before disabling the plugin', async () => {
    const calls: string[] = []
    let running = false
    const controller: PluginToolRuntimeController = {
      enable(candidate) {
        calls.push(`enable:${candidate.manifest.name}`)
        running = true
        return Promise.resolve()
      },
      disable(pluginId) {
        calls.push(`disable:${pluginId}`)
        running = false
        return Promise.resolve()
      },
      isRunning: () => running,
      registrations: () => null,
      invokeTool: () => Promise.resolve(null),
      invokeModel: () => Promise.resolve(null),
    }
    setPluginToolRuntimeController(controller)
    const registry = makeRegistry()
    const service = createPluginService(registry)
    await service.addPluginSource(await makeToolPlugin())
    const plugin = service.list().find((candidate) => candidate.id === 'personal.local-tools')
    assert.ok(plugin?.source)
    assert.equal(registry.isEnabled(plugin.id), true)
    assert.equal(parseStringList(storageGet(PLUGIN_DISABLED_KEY)).includes(plugin.id), false)

    await service.setEnabled(plugin.id, false)
    assert.equal(registry.isEnabled(plugin.id), false)
    assert.deepEqual(calls, [`enable:${plugin.id}`, `disable:${plugin.id}`])
  })

  it('getPluginService() installs a singleton registry with the first-party plugins', () => {
    const service = getPluginService()
    assert.equal(typeof service.registry.all, 'function')
    assert.ok(service.registry.all().length >= 1)
    // Second call returns the same singleton — critical so the IPC layer + the
    // hook-registry provider read through the same instance.
    assert.equal(getPluginService(), service)
  })

  it('seeds the default-off plugins on a profile that has no plugin list', () => {
    storageDelete(PLUGIN_DISABLED_KEY)

    const service = getPluginService()

    // Post-turn review has always been on; every experimental plugin starts off.
    assert.equal(service.registry.isEnabled(POST_TURN_REVIEW_PLUGIN_ID), true)
    for (const id of [
      MODEL_COMPARISON_PLUGIN_ID,
      LONG_HORIZON_TASKS_PLUGIN_ID,
      ROADMAP_PLANS_PLUGIN_ID,
      ADVISOR_STRATEGY_PLUGIN_ID,
      OKF_MEMORIES_PLUGIN_ID,
      CI_INVESTIGATOR_PLUGIN_ID,
      PII_REDACTION_PLUGIN_ID,
      FORCED_PLANNING_PLUGIN_ID,
      // Added with the contribution kinds (#1188-#1190); each replaces a retired
      // opt-in boolean, so each must ship off like its predecessor.
      MCP_UI_CANVAS_PLUGIN_ID,
      DEVTOOLS_SHORTCUT_PLUGIN_ID,
      BACKGROUND_TASKS_PLUGIN_ID,
      AUTOMATIONS_PLUGIN_ID,
      DARK_FACTORY_PLUGIN_ID,
      PARALLEL_SEARCH_PLUGIN_ID,
    ]) {
      assert.equal(service.registry.isEnabled(id), false, id)
    }
    assert.deepEqual(
      storageGet(PLUGIN_DISABLED_KEY),
      [
        MODEL_COMPARISON_PLUGIN_ID,
        LONG_HORIZON_TASKS_PLUGIN_ID,
        ROADMAP_PLANS_PLUGIN_ID,
        ADVISOR_STRATEGY_PLUGIN_ID,
        OKF_MEMORIES_PLUGIN_ID,
        CI_INVESTIGATOR_PLUGIN_ID,
        PII_REDACTION_PLUGIN_ID,
        FORCED_PLANNING_PLUGIN_ID,
        MCP_UI_CANVAS_PLUGIN_ID,
        DEVTOOLS_SHORTCUT_PLUGIN_ID,
        BACKGROUND_TASKS_PLUGIN_ID,
        AUTOMATIONS_PLUGIN_ID,
        DARK_FACTORY_PLUGIN_ID,
        PARALLEL_SEARCH_PLUGIN_ID,
      ].sort(),
    )
  })

  it('seeds the new automations plugin disabled without erasing later choices', async () => {
    storageDelete(AUTOMATIONS_ENABLEMENT_MIGRATION_KEY)
    const service = getPluginService()
    assert.equal(service.registry.isEnabled(AUTOMATIONS_PLUGIN_ID), false)
    const disabled = storageGet(PLUGIN_DISABLED_KEY)
    assert.ok(Array.isArray(disabled))
    assert.ok(disabled.includes(AUTOMATIONS_PLUGIN_ID))
    assert.equal(storageGet(AUTOMATIONS_ENABLEMENT_MIGRATION_KEY), true)

    await service.setEnabled(AUTOMATIONS_PLUGIN_ID, true)
    __resetPluginServiceForTests()
    const later = getPluginService()
    assert.equal(later.registry.isEnabled(AUTOMATIONS_PLUGIN_ID), true)
  })

  it('seeds Parallel Search off once for existing profiles without erasing later choices', async () => {
    storageDelete(PARALLEL_SEARCH_ENABLEMENT_MIGRATION_KEY)
    const service = getPluginService()
    assert.equal(service.registry.isEnabled(PARALLEL_SEARCH_PLUGIN_ID), false)
    assert.equal(storageGet(PARALLEL_SEARCH_ENABLEMENT_MIGRATION_KEY), true)

    await service.setEnabled(PARALLEL_SEARCH_PLUGIN_ID, true)
    __resetPluginServiceForTests()
    const later = getPluginService()
    assert.equal(later.registry.isEnabled(PARALLEL_SEARCH_PLUGIN_ID), true)
  })

  it('never re-seeds over a plugin list the user already owns', () => {
    // Everything default-off except model comparison, which the user enabled.
    storageSet(PLUGIN_DISABLED_KEY, [
      LONG_HORIZON_TASKS_PLUGIN_ID,
      ROADMAP_PLANS_PLUGIN_ID,
      ADVISOR_STRATEGY_PLUGIN_ID,
      OKF_MEMORIES_PLUGIN_ID,
      CI_INVESTIGATOR_PLUGIN_ID,
      PII_REDACTION_PLUGIN_ID,
      AUTOMATIONS_PLUGIN_ID,
    ])

    const service = getPluginService()

    assert.equal(service.registry.isEnabled(MODEL_COMPARISON_PLUGIN_ID), true)
    assert.equal(service.registry.isEnabled(PII_REDACTION_PLUGIN_ID), false)
    assert.equal(
      parseStringList(storageGet(PLUGIN_DISABLED_KEY)).includes(MODEL_COMPARISON_PLUGIN_ID),
      false,
    )
  })

  it('treats an empty plugin list as the user turning everything on', () => {
    storageSet(PLUGIN_DISABLED_KEY, [])

    const service = getPluginService()

    assert.equal(service.registry.isEnabled(PII_REDACTION_PLUGIN_ID), true)
    assert.deepEqual(storageGet(PLUGIN_DISABLED_KEY), [])
  })

  it('never re-disables forced planning once the user has enabled it', () => {
    // The plugin rewrites the system prompt of every turn on a below-threshold
    // model, so it is in the default-off set — but only as a *seed*. A list the
    // user owns wins, including one that leaves forced planning on.
    storageSet(PLUGIN_DISABLED_KEY, [PII_REDACTION_PLUGIN_ID])

    const service = getPluginService()

    assert.equal(service.registry.isEnabled(FORCED_PLANNING_PLUGIN_ID), true)
    assert.deepEqual(storageGet(PLUGIN_DISABLED_KEY), [PII_REDACTION_PLUGIN_ID])
  })
})

// C3 of docs/plans/agent-plugins-migration.md — the `pack*` → `plugin*` key
// rename. These are the cases where getting it wrong is *silent*: nobody sees
// an error, they just find their choices reverted after an update.
describe('migratePackKeysToPlugin', () => {
  const OLD_KEYS = [
    'packDisabled',
    'packSources',
    'packMigration.packModelSettings',
    'packMigration.automationsEnablement',
    'packMigration.parallelSearchEnablement',
    'pack.demo.plugin.settings',
  ]
  const NEW_KEYS = [
    'pluginDisabled',
    'pluginSources',
    'pluginMigration.pluginModelSettings',
    'pluginMigration.automationsEnablement',
    'pluginMigration.parallelSearchEnablement',
    'plugin.demo.plugin.settings',
  ]

  function wipe(): void {
    for (const key of [...OLD_KEYS, ...NEW_KEYS]) storageDelete(key)
  }

  beforeEach(() => {
    __resetPluginServiceForTests()
    wipe()
  })

  afterEach(() => {
    __resetPluginServiceForTests()
    wipe()
    clearStorage()
  })

  it('carries a disable set forward instead of re-seeding the shipped defaults', () => {
    // A profile that turned an experiment ON (absent from the list) and a
    // stable plugin OFF (present). Both must survive.
    storageSet('packDisabled', ['copse.todos'])
    storageSet('packMigration.automationsEnablement', true)
    storageSet('packMigration.parallelSearchEnablement', true)

    getPluginService()

    assert.deepEqual(parseStringList(storageGet('pluginDisabled')), ['copse.todos'])
    // The seeding path must not have fired: `copse.model-comparison` ships
    // disabled, and its absence here is the user's explicit opt-in.
    assert.equal(
      parseStringList(storageGet('pluginDisabled')).includes(MODEL_COMPARISON_PLUGIN_ID),
      false,
    )
  })

  it('treats an empty disable set as a value, not a blank', () => {
    // `[]` means "everything on" — the opposite of "never configured". Copying
    // it is what stops a fully-opted-in profile reverting to the defaults.
    storageSet('packDisabled', [])
    storageSet('packMigration.automationsEnablement', true)
    storageSet('packMigration.parallelSearchEnablement', true)

    getPluginService()

    assert.deepEqual(storageGet('pluginDisabled'), [])
  })

  it('carries per-plugin settings bags forward, ids containing dots included', () => {
    storageSet('packDisabled', [])
    storageSet('pack.demo.plugin.settings', { strictness: 4 })

    getPluginService()

    assert.deepEqual(storageGet('plugin.demo.plugin.settings'), { strictness: 4 })
  })

  it('never overwrites a value already written under the new key', () => {
    storageSet('packDisabled', ['stale.from.before'])
    storageSet('pluginDisabled', ['current'])

    getPluginService()

    // Asserting membership rather than the whole array: the automations and
    // parallel-search one-shots legitimately append their own default-off ids
    // on a profile that has not seen them, and that is not this test's subject.
    const after = parseStringList(storageGet('pluginDisabled'))
    assert.equal(after.includes('current'), true, 'the existing value must survive')
    assert.equal(
      after.includes('stale.from.before'),
      false,
      'the old key must not have been copied over it',
    )
  })

  it('leaves the old keys in place so a downgrade still finds them', () => {
    storageSet('packDisabled', ['copse.todos'])

    getPluginService()

    assert.deepEqual(parseStringList(storageGet('packDisabled')), ['copse.todos'])
  })

  it('is inert on a profile that never had the old keys', () => {
    getPluginService()
    // Nothing to carry forward, so seeding owns the result: the shipped
    // default-off set, exactly as a fresh install gets.
    assert.equal(parseStringList(storageGet('pluginDisabled')).length > 0, true)
    assert.equal(storageGet('packDisabled'), undefined)
  })
})

// Settings → MCP servers reads this to disclose servers nothing is running.
// The value of the disclosure rests entirely on it being *complete* and on it
// staying inert, so both are pinned: a declaration reaches the list whether or
// not its plugin is on, and reading it never starts anything.
describe('declaredMcpServers', () => {
  const roots: string[] = []

  async function seedPlugin(
    name: string,
    servers: Record<string, unknown> | null,
  ): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'copse-declared-mcp-'))
    roots.push(root)
    const pluginDir = join(root, name)
    await mkdir(pluginDir, { recursive: true })
    await writeFile(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name,
        version: '1.0.0',
      }),
    )
    if (servers) {
      await writeFile(
        join(pluginDir, 'mcp.json'),
        JSON.stringify({
          $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
          mcpServers: servers,
        }),
      )
    }
    return root
  }

  beforeEach(() => {
    __resetPluginServiceForTests()
    clearStorage()
  })

  afterEach(async () => {
    __resetPluginServiceForTests()
    delete process.env['COPSE_PLUGINS_DIR']
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('reports a disabled plugin server, naming the plugin and why it is inert', async () => {
    process.env['COPSE_PLUGINS_DIR'] = await seedPlugin('acme.declarer', {
      reviewer: { type: 'stdio', command: './bin/reviewer' },
    })

    const service = createPluginService(makeRegistry())
    await service.refreshUserPlugins()

    // Discovery seeds a newly found plugin off, which is the common case for
    // this list: the server is not running because the plugin is not.
    assert.deepEqual(service.declaredMcpServers(), [
      {
        name: 'reviewer',
        transport: 'stdio',
        pluginId: 'acme.declarer',
        pluginEnabled: false,
        reason: 'The plugin that declares it is turned off.',
      },
    ])
  })

  it('keeps reporting the server once the user turns the plugin on', async () => {
    process.env['COPSE_PLUGINS_DIR'] = await seedPlugin('acme.declarer', {
      reviewer: { type: 'stdio', command: './bin/reviewer' },
    })

    const service = createPluginService(makeRegistry())
    await service.refreshUserPlugins()
    await service.setEnabled('acme.declarer', true)

    // Enabling a plugin does not start its MCP servers, so the row has to stay —
    // dropping it here would read as "now running", which is the one thing it
    // must never imply.
    const [declared] = service.declaredMcpServers()
    assert.ok(declared)
    assert.equal(declared.pluginEnabled, true)
    assert.match(declared.reason, /does not start plugin MCP servers yet/)
  })

  it('is empty when no discovered plugin declares any', async () => {
    process.env['COPSE_PLUGINS_DIR'] = await seedPlugin('acme.quiet', null)

    const service = createPluginService(makeRegistry())
    await service.refreshUserPlugins()

    assert.deepEqual(service.declaredMcpServers(), [])
  })
})
