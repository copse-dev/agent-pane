// Contract test: the `copse.mcp-ui-canvas` first-party plugin.
//
// Landing invariants pinned here (mirrors roadmap-plans-plugin.test.ts, adapted
// for a capability-only plugin):
//
// 1. **The plugin is registered** in `FIRST_PARTY_PLUGINS` with id
//    `copse.mcp-ui-canvas` and trust `first-party`, and its manifest +
//    contributions declare the `mcp-ui-canvas` capability and NO tool/hook/
//    prompt/ui (it is a pure behaviour flag).
// 2. **Single owner.** Across the shipped seed the `mcp-ui-canvas` capability is
//    declared exactly once, so the host read sites (`mcp-registry.ts`) resolve
//    it unambiguously through `isCapabilityActive`.
// 3. **Atomicity of disable.** One flag flip drops the capability from
//    `isCapabilityActive('mcp-ui-canvas')`; plugin storage (none declared here) is
//    irrelevant. The default-OFF product behaviour is enforced by the
//    plugin-service enablement migration, not by the raw registry seed, so this
//    test toggles enablement explicitly.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  mcpUiCanvasPlugin,
  MCP_UI_CANVAS_PLUGIN_ID,
  MCP_UI_CANVAS_CAPABILITY,
} from './mcp-ui-canvas-plugin.ts'
import { createFirstPartyPluginRegistry, FIRST_PARTY_PLUGINS } from './first-party-plugins.ts'

describe('copse.mcp-ui-canvas plugin', () => {
  it('is registered in FIRST_PARTY_PLUGINS with id copse.mcp-ui-canvas', () => {
    assert.equal(mcpUiCanvasPlugin.id, MCP_UI_CANVAS_PLUGIN_ID)
    assert.equal(mcpUiCanvasPlugin.trust, 'first-party')
    assert.ok(
      FIRST_PARTY_PLUGINS.some((plugin) => plugin.id === MCP_UI_CANVAS_PLUGIN_ID),
      'mcp-ui-canvas plugin must be part of the shipped first-party plugin list',
    )
  })

  it('declares the mcp-ui-canvas capability and no tool/hook/prompt/ui contributions', () => {
    assert.deepEqual(mcpUiCanvasPlugin.manifest.capabilities, [
      {
        name: MCP_UI_CANVAS_CAPABILITY,
        title: 'MCP-UI canvas rendering',
        description: mcpUiCanvasPlugin.manifest.capabilities?.[0]?.description,
      },
    ])
    assert.equal(mcpUiCanvasPlugin.contributions.capabilities[0]?.name, MCP_UI_CANVAS_CAPABILITY)
    // A pure behaviour flag: nothing else is contributed. Pinning this shape
    // makes any accidental extra contribution a mechanical failure.
    assert.deepEqual(mcpUiCanvasPlugin.contributions.toolNames, [])
    assert.deepEqual(mcpUiCanvasPlugin.contributions.blockingHooks, [])
    assert.deepEqual(mcpUiCanvasPlugin.contributions.asyncHooks, [])
    assert.deepEqual(mcpUiCanvasPlugin.contributions.promptBlocks, [])
    assert.deepEqual(mcpUiCanvasPlugin.contributions.uiContributions, [])
    assert.equal(mcpUiCanvasPlugin.manifest.tools, undefined)
  })

  it('declares mcp-ui-canvas exactly once across all first-party plugins', () => {
    const occurrences = FIRST_PARTY_PLUGINS.flatMap((plugin) =>
      plugin.contributions.capabilities.map((c) => c.name),
    ).filter((name) => name === MCP_UI_CANVAS_CAPABILITY)
    assert.equal(occurrences.length, 1)
  })

  it('atomically drops the capability on disable', () => {
    const registry = createFirstPartyPluginRegistry()
    assert.equal(registry.isEnabled(MCP_UI_CANVAS_PLUGIN_ID), true)
    assert.equal(registry.isCapabilityActive(MCP_UI_CANVAS_CAPABILITY), true)

    registry.disable(MCP_UI_CANVAS_PLUGIN_ID)
    assert.equal(registry.isEnabled(MCP_UI_CANVAS_PLUGIN_ID), false)
    assert.equal(
      registry.isCapabilityActive(MCP_UI_CANVAS_CAPABILITY),
      false,
      'mcp-ui-canvas must leave isCapabilityActive() the moment the plugin is disabled',
    )

    registry.enable(MCP_UI_CANVAS_PLUGIN_ID)
    assert.equal(registry.isCapabilityActive(MCP_UI_CANVAS_CAPABILITY), true)
  })
})
