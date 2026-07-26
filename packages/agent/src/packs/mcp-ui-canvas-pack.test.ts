// Contract test: the `copse.mcp-ui-canvas` first-party pack.
//
// Landing invariants pinned here (mirrors roadmap-plans-pack.test.ts, adapted
// for a capability-only pack):
//
// 1. **The pack is registered** in `FIRST_PARTY_PACKS` with id
//    `copse.mcp-ui-canvas` and trust `first-party`, and its manifest +
//    contributions declare the `mcp-ui-canvas` capability and NO tool/hook/
//    prompt/ui (it is a pure behaviour flag).
// 2. **Single owner.** Across the shipped seed the `mcp-ui-canvas` capability is
//    declared exactly once, so the host read sites (`mcp-registry.ts`) resolve
//    it unambiguously through `isCapabilityActive`.
// 3. **Atomicity of disable.** One flag flip drops the capability from
//    `isCapabilityActive('mcp-ui-canvas')`; pack storage (none declared here) is
//    irrelevant. The default-OFF product behaviour is enforced by the
//    pack-service enablement migration, not by the raw registry seed, so this
//    test toggles enablement explicitly.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  mcpUiCanvasPack,
  MCP_UI_CANVAS_PACK_ID,
  MCP_UI_CANVAS_CAPABILITY,
} from './mcp-ui-canvas-pack.ts'
import { createFirstPartyPackRegistry, FIRST_PARTY_PACKS } from './first-party-packs.ts'

describe('copse.mcp-ui-canvas pack', () => {
  it('is registered in FIRST_PARTY_PACKS with id copse.mcp-ui-canvas', () => {
    assert.equal(mcpUiCanvasPack.id, MCP_UI_CANVAS_PACK_ID)
    assert.equal(mcpUiCanvasPack.trust, 'first-party')
    assert.ok(
      FIRST_PARTY_PACKS.some((pack) => pack.id === MCP_UI_CANVAS_PACK_ID),
      'mcp-ui-canvas pack must be part of the shipped first-party pack list',
    )
  })

  it('declares the mcp-ui-canvas capability and no tool/hook/prompt/ui contributions', () => {
    assert.deepEqual(mcpUiCanvasPack.manifest.capabilities, [
      {
        name: MCP_UI_CANVAS_CAPABILITY,
        title: 'MCP-UI canvas rendering',
        description: mcpUiCanvasPack.manifest.capabilities?.[0]?.description,
      },
    ])
    assert.equal(mcpUiCanvasPack.contributions.capabilities[0]?.name, MCP_UI_CANVAS_CAPABILITY)
    // A pure behaviour flag: nothing else is contributed. Pinning this shape
    // makes any accidental extra contribution a mechanical failure.
    assert.deepEqual(mcpUiCanvasPack.contributions.toolNames, [])
    assert.deepEqual(mcpUiCanvasPack.contributions.blockingHooks, [])
    assert.deepEqual(mcpUiCanvasPack.contributions.asyncHooks, [])
    assert.deepEqual(mcpUiCanvasPack.contributions.promptBlocks, [])
    assert.deepEqual(mcpUiCanvasPack.contributions.uiContributions, [])
    assert.equal(mcpUiCanvasPack.manifest.tools, undefined)
  })

  it('declares mcp-ui-canvas exactly once across all first-party packs', () => {
    const occurrences = FIRST_PARTY_PACKS.flatMap((pack) =>
      pack.contributions.capabilities.map((c) => c.name),
    ).filter((name) => name === MCP_UI_CANVAS_CAPABILITY)
    assert.equal(occurrences.length, 1)
  })

  it('atomically drops the capability on disable', () => {
    const registry = createFirstPartyPackRegistry()
    assert.equal(registry.isEnabled(MCP_UI_CANVAS_PACK_ID), true)
    assert.equal(registry.isCapabilityActive(MCP_UI_CANVAS_CAPABILITY), true)

    registry.disable(MCP_UI_CANVAS_PACK_ID)
    assert.equal(registry.isEnabled(MCP_UI_CANVAS_PACK_ID), false)
    assert.equal(
      registry.isCapabilityActive(MCP_UI_CANVAS_CAPABILITY),
      false,
      'mcp-ui-canvas must leave isCapabilityActive() the moment the pack is disabled',
    )

    registry.enable(MCP_UI_CANVAS_PACK_ID)
    assert.equal(registry.isCapabilityActive(MCP_UI_CANVAS_CAPABILITY), true)
  })
})
