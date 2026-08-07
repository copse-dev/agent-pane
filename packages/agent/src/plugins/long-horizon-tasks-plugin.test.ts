// Contract test: the `copse.long-horizon-tasks` first-party plugin.
//
// Landing invariants pinned here (mirrors model-comparison-plugin.test.ts):
//
// 1. **The plugin is registered** in `FIRST_PARTY_PLUGINS` with id
//    `copse.long-horizon-tasks` and trust `first-party`, and its manifest +
//    contributions declare the `track_long_task` native tool.
// 2. **No double-registration.** Historically the tool was gated by the
//    top-level `longHorizonTasksEnabled` boolean, which is deleted in the same
//    change (`registry-bootstrap.ts` no longer imports it; the
//    `settings-writable.ts` schema no longer accepts it) — the plugin registry is
//    the single source of truth. This test scans the shipped seed and asserts
//    `track_long_task` appears exactly once in `activeToolNames()` (i.e. only
//    the plugin contributes it), and that no async/blocking hooks are contributed
//    twice under this plugin id.
// 3. **Atomicity of disable.** One flag flip drops the tool from
//    `activeToolNames()`; the host tool-registry sync
//    (`syncLongHorizonTasksTools` in `registry-bootstrap.ts`) reads the same
//    plugin registry and unregisters the concrete tool object on toggle. Plugin
//    storage survives the disable (decision 17).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  longHorizonTasksPlugin,
  LONG_HORIZON_TASKS_PLUGIN_ID,
  LONG_HORIZON_TASKS_TOOL_NAME,
} from './long-horizon-tasks-plugin.ts'
import { createFirstPartyPluginRegistry, FIRST_PARTY_PLUGINS } from './first-party-plugins.ts'

describe('copse.long-horizon-tasks plugin', () => {
  it('is registered in FIRST_PARTY_PLUGINS with id copse.long-horizon-tasks', () => {
    assert.equal(longHorizonTasksPlugin.id, LONG_HORIZON_TASKS_PLUGIN_ID)
    assert.equal(longHorizonTasksPlugin.trust, 'first-party')
    assert.ok(
      FIRST_PARTY_PLUGINS.some((plugin) => plugin.id === LONG_HORIZON_TASKS_PLUGIN_ID),
      'long-horizon-tasks plugin must be part of the shipped first-party plugin list',
    )
  })

  it('declares the track_long_task tool, namespaced storage, and no hook contributions', () => {
    assert.deepEqual(longHorizonTasksPlugin.manifest.tools?.native, [LONG_HORIZON_TASKS_TOOL_NAME])
    assert.deepEqual(longHorizonTasksPlugin.manifest.storage, {
      namespace: LONG_HORIZON_TASKS_PLUGIN_ID,
    })
    assert.deepEqual(longHorizonTasksPlugin.contributions.toolNames, [LONG_HORIZON_TASKS_TOOL_NAME])
    // The tool is an inline registration site, not a static hook, so the plugin
    // contributes nothing to the function-hook lists. Pinning this shape makes
    // any accidental double-registration regression a mechanical failure.
    assert.deepEqual(longHorizonTasksPlugin.contributions.blockingHooks, [])
    assert.deepEqual(longHorizonTasksPlugin.contributions.asyncHooks, [])
    assert.deepEqual(longHorizonTasksPlugin.contributions.promptBlocks, [])
    assert.deepEqual(longHorizonTasksPlugin.contributions.uiContributions, [])
  })

  it('contributes track_long_task exactly once across all first-party plugins', () => {
    // Across the whole shipped seed no other plugin contributes the tool name
    // — otherwise the tool registration in `registry-bootstrap.ts` would be
    // ambiguous once tools are read through the plugin registry.
    const occurrences = FIRST_PARTY_PLUGINS.flatMap(
      (plugin) => plugin.contributions.toolNames,
    ).filter((name) => name === LONG_HORIZON_TASKS_TOOL_NAME)
    assert.equal(occurrences.length, 1)
  })

  it('atomically drops the tool from the active seed on disable', () => {
    const registry = createFirstPartyPluginRegistry()
    assert.equal(registry.isEnabled(LONG_HORIZON_TASKS_PLUGIN_ID), true)
    assert.ok(registry.activeToolNames().includes(LONG_HORIZON_TASKS_TOOL_NAME))

    // Plugin storage survives disable (decision 17).
    registry.storage(LONG_HORIZON_TASKS_PLUGIN_ID).set('lastTask', 't-1')

    registry.disable(LONG_HORIZON_TASKS_PLUGIN_ID)
    assert.equal(registry.isEnabled(LONG_HORIZON_TASKS_PLUGIN_ID), false)
    assert.ok(
      !registry.activeToolNames().includes(LONG_HORIZON_TASKS_TOOL_NAME),
      'track_long_task must leave activeToolNames() the moment the plugin is disabled',
    )

    registry.enable(LONG_HORIZON_TASKS_PLUGIN_ID)
    assert.ok(registry.activeToolNames().includes(LONG_HORIZON_TASKS_TOOL_NAME))
    assert.equal(registry.storage(LONG_HORIZON_TASKS_PLUGIN_ID).get('lastTask'), 't-1')
  })
})
