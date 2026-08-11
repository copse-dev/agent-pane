// Contract test: the `copse.okf-memories` first-party plugin.
//
// Landing invariants pinned here (mirrors model-comparison-plugin.test.ts):
//
// 1. **The plugin is registered** in `FIRST_PARTY_PLUGINS` with id
//    `copse.okf-memories` and trust `first-party`, and its manifest +
//    contributions declare the `remember`/`recall` native tools and the memory
//    steering prompt block.
// 2. **No double-registration.** Historically the tools were gated by the
//    top-level `okfMemoriesEnabled` boolean, which is deleted in the same change
//    (`registry-bootstrap.ts` no longer imports it; the `settings-writable.ts`
//    schema no longer accepts it) — the plugin registry is the single source of
//    truth. This test scans the shipped seed and asserts each tool name appears
//    exactly once in `activeToolNames()` (i.e. only the plugin contributes it),
//    and that no async/blocking hooks are contributed under this plugin id.
// 3. **Atomicity of disable.** One flag flip drops both tools from
//    `activeToolNames()`; the host tool-registry sync (`syncOkfMemoryTools` in
//    `registry-bootstrap.ts`) reads the same plugin registry and unregisters the
//    concrete tool objects on toggle. Plugin storage survives the disable
//    (decision 17).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  okfMemoriesPlugin,
  OKF_MEMORIES_PLUGIN_ID,
  OKF_MEMORIES_TOOL_NAMES,
  OKF_MEMORIES_PROMPT_BLOCK_ID,
  MEMORY_TOOLS_BLOCK,
} from './okf-memories-plugin.ts'
import { createFirstPartyPluginRegistry, FIRST_PARTY_PLUGINS } from './first-party-plugins.ts'

describe('copse.okf-memories plugin', () => {
  it('is registered in FIRST_PARTY_PLUGINS with id copse.okf-memories', () => {
    assert.equal(okfMemoriesPlugin.id, OKF_MEMORIES_PLUGIN_ID)
    assert.equal(okfMemoriesPlugin.trust, 'first-party')
    assert.ok(
      FIRST_PARTY_PLUGINS.some((plugin) => plugin.id === OKF_MEMORIES_PLUGIN_ID),
      'okf-memories plugin must be part of the shipped first-party plugin list',
    )
  })

  it('declares the remember/recall tools, the memory prompt block, namespaced storage, and no hooks', () => {
    assert.deepEqual(okfMemoriesPlugin.manifest.tools?.native, [...OKF_MEMORIES_TOOL_NAMES])
    assert.deepEqual(okfMemoriesPlugin.manifest.storage, {
      namespace: OKF_MEMORIES_PLUGIN_ID,
    })
    assert.deepEqual(okfMemoriesPlugin.contributions.toolNames, [...OKF_MEMORIES_TOOL_NAMES])
    // The memory steering block is a trusted first-party prompt contribution;
    // the host appends the identical text (imported from the plugin) while the
    // plugin is enabled. Pinning the shape keeps the plugin decl and the host
    // appending site from drifting.
    assert.deepEqual(okfMemoriesPlugin.manifest.prompt, [
      { id: OKF_MEMORIES_PROMPT_BLOCK_ID, text: MEMORY_TOOLS_BLOCK, trust: 'trusted' },
    ])
    assert.deepEqual(okfMemoriesPlugin.contributions.promptBlocks, [
      { id: OKF_MEMORIES_PROMPT_BLOCK_ID, text: MEMORY_TOOLS_BLOCK, trust: 'trusted' },
    ])
    // The tools are inline registration sites, not static hooks, so the plugin
    // contributes nothing to the function-hook lists. Pinning this shape makes
    // any accidental double-registration regression a mechanical failure.
    assert.deepEqual(okfMemoriesPlugin.contributions.blockingHooks, [])
    assert.deepEqual(okfMemoriesPlugin.contributions.asyncHooks, [])
    assert.deepEqual(okfMemoriesPlugin.contributions.uiContributions, [])
  })

  it('contributes remember and recall exactly once each across all first-party plugins', () => {
    // Across the whole shipped seed no other plugin contributes either tool name
    // — otherwise the tool registration in `registry-bootstrap.ts` would be
    // ambiguous once tools are read through the plugin registry.
    const allToolNames = FIRST_PARTY_PLUGINS.flatMap((plugin) => plugin.contributions.toolNames)
    for (const name of OKF_MEMORIES_TOOL_NAMES) {
      assert.equal(
        allToolNames.filter((n) => n === name).length,
        1,
        `${name} must be contributed by exactly one plugin`,
      )
    }
  })

  it('atomically drops both tools from the active seed on disable', () => {
    const registry = createFirstPartyPluginRegistry()
    assert.equal(registry.isEnabled(OKF_MEMORIES_PLUGIN_ID), true)
    for (const name of OKF_MEMORIES_TOOL_NAMES) {
      assert.ok(registry.activeToolNames().includes(name))
    }

    // Plugin storage survives disable (decision 17).
    registry.storage(OKF_MEMORIES_PLUGIN_ID).set('lastMemory', 'm-1')

    registry.disable(OKF_MEMORIES_PLUGIN_ID)
    assert.equal(registry.isEnabled(OKF_MEMORIES_PLUGIN_ID), false)
    for (const name of OKF_MEMORIES_TOOL_NAMES) {
      assert.ok(
        !registry.activeToolNames().includes(name),
        `${name} must leave activeToolNames() the moment the plugin is disabled`,
      )
    }

    registry.enable(OKF_MEMORIES_PLUGIN_ID)
    for (const name of OKF_MEMORIES_TOOL_NAMES) {
      assert.ok(registry.activeToolNames().includes(name))
    }
    assert.equal(registry.storage(OKF_MEMORIES_PLUGIN_ID).get('lastMemory'), 'm-1')
  })
})
