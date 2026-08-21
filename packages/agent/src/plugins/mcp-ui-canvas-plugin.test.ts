// Contract test: the `copse.mcp-ui-canvas` first-party plugin.
//
// Landing invariants pinned here (mirrors roadmap-plans-plugin.test.ts, adapted
// for a capability-only plugin):
//
// 1. **The plugin is registered** in `FIRST_PARTY_PLUGINS` with id
//    `copse.mcp-ui-canvas` and trust `first-party`, and its manifest +
//    contributions declare the `mcp-ui-canvas` capability plus exactly one
//    turn-start hook (the prototype steering) and NO tool/prompt/ui.
// 2. **Single owner.** Across the shipped seed the `mcp-ui-canvas` capability is
//    declared exactly once, so the host read sites (`mcp-registry.ts`) resolve
//    it unambiguously through `isCapabilityActive`.
// 3. **Atomicity of disable.** One flag flip drops both the capability from
//    `isCapabilityActive('mcp-ui-canvas')` and the steering hook from
//    `activeBlockingHooks()`; plugin storage (none declared here) is irrelevant.
//    The default-OFF product behaviour is enforced by the plugin-service
//    enablement migration, not by the raw registry seed, so this test toggles
//    enablement explicitly.
// 4. **The steering hook fires only on a prototype turn that offers the canvas
//    tool**, and names the prefixed tool the turn actually got.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  mcpUiCanvasPlugin,
  MCP_UI_CANVAS_PLUGIN_ID,
  MCP_UI_CANVAS_CAPABILITY,
} from './mcp-ui-canvas-plugin.ts'
import { createFirstPartyPluginRegistry, FIRST_PARTY_PLUGINS } from './first-party-plugins.ts'
import { canvasPrototypeSteeringHook } from '../hooks/turn-start-hooks.ts'
import { CANVAS_ARTEFACT_TOOL } from '../canvas-prototype-steering.ts'
import type { HookContext } from '../hooks/canonical-events.ts'

describe('copse.mcp-ui-canvas plugin', () => {
  it('is registered in FIRST_PARTY_PLUGINS with id copse.mcp-ui-canvas', () => {
    assert.equal(mcpUiCanvasPlugin.id, MCP_UI_CANVAS_PLUGIN_ID)
    assert.equal(mcpUiCanvasPlugin.trust, 'first-party')
    assert.ok(
      FIRST_PARTY_PLUGINS.some((plugin) => plugin.id === MCP_UI_CANVAS_PLUGIN_ID),
      'mcp-ui-canvas plugin must be part of the shipped first-party plugin list',
    )
  })

  it('declares the mcp-ui-canvas capability and only the steering hook alongside it', () => {
    assert.deepEqual(mcpUiCanvasPlugin.manifest.capabilities, [
      {
        name: MCP_UI_CANVAS_CAPABILITY,
        title: 'MCP-UI canvas rendering',
        description: mcpUiCanvasPlugin.manifest.capabilities?.[0]?.description,
      },
    ])
    assert.equal(mcpUiCanvasPlugin.contributions.capabilities[0]?.name, MCP_UI_CANVAS_CAPABILITY)
    // A behaviour flag plus one conditional steering hook: nothing else is
    // contributed. Pinning this shape makes any accidental extra contribution a
    // mechanical failure.
    assert.deepEqual(mcpUiCanvasPlugin.contributions.toolNames, [])
    assert.deepEqual(
      mcpUiCanvasPlugin.contributions.blockingHooks.map((hook) => hook.id),
      ['canvas-prototype-steering'],
    )
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

  it('atomically drops the capability and the steering hook on disable', () => {
    const registry = createFirstPartyPluginRegistry()
    const steeringActive = (): boolean =>
      registry.activeBlockingHooks().some((hook) => hook.id === 'canvas-prototype-steering')
    assert.equal(registry.isEnabled(MCP_UI_CANVAS_PLUGIN_ID), true)
    assert.equal(registry.isCapabilityActive(MCP_UI_CANVAS_CAPABILITY), true)
    assert.equal(steeringActive(), true)

    registry.disable(MCP_UI_CANVAS_PLUGIN_ID)
    assert.equal(registry.isEnabled(MCP_UI_CANVAS_PLUGIN_ID), false)
    assert.equal(
      registry.isCapabilityActive(MCP_UI_CANVAS_CAPABILITY),
      false,
      'mcp-ui-canvas must leave isCapabilityActive() the moment the plugin is disabled',
    )
    assert.equal(
      steeringActive(),
      false,
      'the prototype steering must stop firing in the same flag flip',
    )

    registry.enable(MCP_UI_CANVAS_PLUGIN_ID)
    assert.equal(registry.isCapabilityActive(MCP_UI_CANVAS_CAPABILITY), true)
    assert.equal(steeringActive(), true)
  })
})

describe('canvas prototype steering hook', () => {
  const context = {} as HookContext
  const PROTOTYPE_TURN = 'Build a quick prototype of a sales dashboard'
  const PREFIXED_TOOL = `mcp__copse-canvas__${CANVAS_ARTEFACT_TOOL}`

  it('injects the steering naming the prefixed tool the turn offered', async () => {
    const outcome = await canvasPrototypeSteeringHook.run(
      {
        userText: PROTOTYPE_TURN,
        priorTodos: [],
        toolNames: ['write_file', PREFIXED_TOOL],
      },
      context,
    )
    assert.ok(outcome?.injectContext)
    assert.match(outcome.injectContext, new RegExp(PREFIXED_TOOL))
  })

  it('abstains when the canvas tool was not offered this turn', async () => {
    const withoutCanvas = await canvasPrototypeSteeringHook.run(
      { userText: PROTOTYPE_TURN, priorTodos: [], toolNames: ['write_file'] },
      context,
    )
    assert.equal(withoutCanvas, undefined)

    // No tool list at all: the hook cannot know the canvas is reachable, so it
    // must not instruct the model to call it.
    const withoutList = await canvasPrototypeSteeringHook.run(
      { userText: PROTOTYPE_TURN, priorTodos: [] },
      context,
    )
    assert.equal(withoutList, undefined)
  })

  it('abstains on a turn that is not asking for a prototype', async () => {
    const outcome = await canvasPrototypeSteeringHook.run(
      {
        userText: 'Make the retry count configurable in the HTTP client',
        priorTodos: [],
        toolNames: [PREFIXED_TOOL],
      },
      context,
    )
    assert.equal(outcome, undefined)
  })
})
