// Contract test: the `copse.roadmap-plans` first-party plugin.
//
// Landing invariants pinned here (mirrors model-comparison-plugin.test.ts):
//
// 1. **The plugin is registered** in `FIRST_PARTY_PLUGINS` with id
//    `copse.roadmap-plans` and trust `first-party`, and its manifest +
//    contributions declare the `roadmap_plan` native tool.
// 2. **No double-registration.** Historically the tool was gated by the
//    top-level `roadmapPlansEnabled` boolean, which is deleted in the same
//    change (`registry-bootstrap.ts` no longer imports it; the
//    `settings-writable.ts` schema no longer accepts it) — the plugin registry is
//    the single source of truth. This test scans the shipped seed and asserts
//    `roadmap_plan` appears exactly once in `activeToolNames()` (i.e. only the
//    plugin contributes it), and that no async/blocking hooks are contributed
//    twice under this plugin id.
// 3. **Atomicity of disable.** One flag flip drops the tool from
//    `activeToolNames()`; the host tool-registry sync (`syncRoadmapPlanTools`
//    in `registry-bootstrap.ts`) reads the same plugin registry and unregisters
//    the concrete tool object on toggle. Plugin storage survives the disable
//    (decision 17).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  roadmapPlansPlugin,
  ROADMAP_PLANS_PLUGIN_ID,
  ROADMAP_PLANS_TOOL_NAME,
} from './roadmap-plans-plugin.ts'
import { createFirstPartyPluginRegistry, FIRST_PARTY_PLUGINS } from './first-party-plugins.ts'

describe('copse.roadmap-plans plugin', () => {
  it('is registered in FIRST_PARTY_PLUGINS with id copse.roadmap-plans', () => {
    assert.equal(roadmapPlansPlugin.id, ROADMAP_PLANS_PLUGIN_ID)
    assert.equal(roadmapPlansPlugin.trust, 'first-party')
    assert.ok(
      FIRST_PARTY_PLUGINS.some((plugin) => plugin.id === ROADMAP_PLANS_PLUGIN_ID),
      'roadmap-plans plugin must be part of the shipped first-party plugin list',
    )
  })

  it('declares the roadmap_plan tool, namespaced storage, and no hook contributions', () => {
    assert.deepEqual(roadmapPlansPlugin.manifest.tools?.native, [ROADMAP_PLANS_TOOL_NAME])
    assert.deepEqual(roadmapPlansPlugin.manifest.storage, {
      namespace: ROADMAP_PLANS_PLUGIN_ID,
    })
    assert.deepEqual(roadmapPlansPlugin.contributions.toolNames, [ROADMAP_PLANS_TOOL_NAME])
    // The tool is an inline registration site, not a static hook, so the plugin
    // contributes nothing to the function-hook lists. Pinning this shape makes
    // any accidental double-registration regression a mechanical failure.
    assert.deepEqual(roadmapPlansPlugin.contributions.blockingHooks, [])
    assert.deepEqual(roadmapPlansPlugin.contributions.asyncHooks, [])
    assert.deepEqual(roadmapPlansPlugin.contributions.promptBlocks, [])
    assert.deepEqual(roadmapPlansPlugin.contributions.uiContributions, [])
  })

  it('contributes roadmap_plan exactly once across all first-party plugins', () => {
    // Across the whole shipped seed no other plugin contributes the tool name
    // — otherwise the tool registration in `registry-bootstrap.ts` would be
    // ambiguous once tools are read through the plugin registry.
    const occurrences = FIRST_PARTY_PLUGINS.flatMap(
      (plugin) => plugin.contributions.toolNames,
    ).filter((name) => name === ROADMAP_PLANS_TOOL_NAME)
    assert.equal(occurrences.length, 1)
  })

  it('atomically drops the tool from the active seed on disable', () => {
    const registry = createFirstPartyPluginRegistry()
    assert.equal(registry.isEnabled(ROADMAP_PLANS_PLUGIN_ID), true)
    assert.ok(registry.activeToolNames().includes(ROADMAP_PLANS_TOOL_NAME))

    // Plugin storage survives disable (decision 17).
    registry.storage(ROADMAP_PLANS_PLUGIN_ID).set('lastItem', 'r-1')

    registry.disable(ROADMAP_PLANS_PLUGIN_ID)
    assert.equal(registry.isEnabled(ROADMAP_PLANS_PLUGIN_ID), false)
    assert.ok(
      !registry.activeToolNames().includes(ROADMAP_PLANS_TOOL_NAME),
      'roadmap_plan must leave activeToolNames() the moment the plugin is disabled',
    )

    registry.enable(ROADMAP_PLANS_PLUGIN_ID)
    assert.ok(registry.activeToolNames().includes(ROADMAP_PLANS_TOOL_NAME))
    assert.equal(registry.storage(ROADMAP_PLANS_PLUGIN_ID).get('lastItem'), 'r-1')
  })
})
