// Contract test: the `copse.advisor-strategy` first-party plugin.
//
// Landing invariants pinned here (mirrors model-comparison-plugin.test.ts):
//
// 1. **The plugin is registered** in `FIRST_PARTY_PLUGINS` with id
//    `copse.advisor-strategy` and trust `first-party`, and its manifest +
//    contributions declare the `advisor` native tool.
// 2. **No double-registration.** Historically the tool was gated by the
//    top-level `advisorStrategyEnabled` boolean, which is deleted in the same
//    change (`registry-bootstrap.ts` no longer imports it; the
//    `settings-writable.ts` schema no longer accepts it) — the plugin registry is
//    the single source of truth. This test scans the shipped seed and asserts
//    `advisor` appears exactly once in `activeToolNames()` (i.e. only the plugin
//    contributes it), and that no async/blocking hooks are contributed twice
//    under this plugin id.
// 3. **Atomicity of disable.** One flag flip drops the tool from
//    `activeToolNames()`; the host tool-registry sync (`syncAdvisorStrategyTools`
//    in `registry-bootstrap.ts`) reads the same plugin registry and unregisters
//    the concrete tool object on toggle. Plugin storage survives the disable
//    (decision 17).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  advisorStrategyPlugin,
  ADVISOR_STRATEGY_PLUGIN_ID,
  ADVISOR_STRATEGY_TOOL_NAME,
  ADVISOR_MODEL_SETTING_ID,
  DEFAULT_ADVISOR_MODEL_ID,
} from './advisor-strategy-plugin.ts'
import { createFirstPartyPluginRegistry, FIRST_PARTY_PLUGINS } from './first-party-plugins.ts'
import { BEST_INTELLECT_MODEL_SELECTOR, parseDynamicModel } from '@copse/llm/dynamic-model.ts'

describe('copse.advisor-strategy plugin', () => {
  it('is registered in FIRST_PARTY_PLUGINS with id copse.advisor-strategy', () => {
    assert.equal(advisorStrategyPlugin.id, ADVISOR_STRATEGY_PLUGIN_ID)
    assert.equal(advisorStrategyPlugin.trust, 'first-party')
    assert.ok(
      FIRST_PARTY_PLUGINS.some((plugin) => plugin.id === ADVISOR_STRATEGY_PLUGIN_ID),
      'advisor-strategy plugin must be part of the shipped first-party plugin list',
    )
  })

  it('declares the advisor tool, namespaced storage, and no hook contributions', () => {
    assert.deepEqual(advisorStrategyPlugin.manifest.tools?.native, [ADVISOR_STRATEGY_TOOL_NAME])
    assert.deepEqual(advisorStrategyPlugin.manifest.storage, {
      namespace: ADVISOR_STRATEGY_PLUGIN_ID,
    })
    assert.deepEqual(advisorStrategyPlugin.contributions.toolNames, [ADVISOR_STRATEGY_TOOL_NAME])
    // The tool is an inline registration site, not a static hook, so the plugin
    // contributes nothing to the function-hook lists. Pinning this shape makes
    // any accidental double-registration regression a mechanical failure.
    assert.deepEqual(advisorStrategyPlugin.contributions.blockingHooks, [])
    assert.deepEqual(advisorStrategyPlugin.contributions.asyncHooks, [])
    assert.deepEqual(advisorStrategyPlugin.contributions.promptBlocks, [])
    assert.deepEqual(advisorStrategyPlugin.contributions.uiContributions, [])
  })

  it('owns the advisor model as a plugin-scoped `model` setting defaulting to a rule', () => {
    // The advisor model moved off the top-level `advisorModel` store key onto
    // this plugin's own `model` field, so the plugin fully owns its model config.
    const field = advisorStrategyPlugin.manifest.settings?.[ADVISOR_MODEL_SETTING_ID]
    assert.ok(field, 'advisor-strategy plugin must declare the advisorModel setting')
    assert.equal(field.kind, 'model')
    assert.equal(field.default, DEFAULT_ADVISOR_MODEL_ID)
    // A dynamic selection, not a pinned id: the advisor must be stronger than
    // whatever the executor happens to be, which no fixed id can promise.
    assert.equal(DEFAULT_ADVISOR_MODEL_ID, BEST_INTELLECT_MODEL_SELECTOR)
    assert.deepEqual(parseDynamicModel(DEFAULT_ADVISOR_MODEL_ID), { kind: 'best-intellect' })
    // A model field never bakes a static option list — the catalogue is live.
    assert.equal(field.options, undefined)
    assert.equal(ADVISOR_MODEL_SETTING_ID, 'advisorModel')
  })

  it('contributes advisor exactly once across all first-party plugins', () => {
    // Across the whole shipped seed no other plugin contributes the tool name
    // — otherwise the tool registration in `registry-bootstrap.ts` would be
    // ambiguous once tools are read through the plugin registry.
    const occurrences = FIRST_PARTY_PLUGINS.flatMap(
      (plugin) => plugin.contributions.toolNames,
    ).filter((name) => name === ADVISOR_STRATEGY_TOOL_NAME)
    assert.equal(occurrences.length, 1)
  })

  it('atomically drops the tool from the active seed on disable', () => {
    const registry = createFirstPartyPluginRegistry()
    assert.equal(registry.isEnabled(ADVISOR_STRATEGY_PLUGIN_ID), true)
    assert.ok(registry.activeToolNames().includes(ADVISOR_STRATEGY_TOOL_NAME))

    // Plugin storage survives disable (decision 17).
    registry.storage(ADVISOR_STRATEGY_PLUGIN_ID).set('lastAdvisor', 'claude-opus-4-8')

    registry.disable(ADVISOR_STRATEGY_PLUGIN_ID)
    assert.equal(registry.isEnabled(ADVISOR_STRATEGY_PLUGIN_ID), false)
    assert.ok(
      !registry.activeToolNames().includes(ADVISOR_STRATEGY_TOOL_NAME),
      'advisor must leave activeToolNames() the moment the plugin is disabled',
    )

    registry.enable(ADVISOR_STRATEGY_PLUGIN_ID)
    assert.ok(registry.activeToolNames().includes(ADVISOR_STRATEGY_TOOL_NAME))
    assert.equal(registry.storage(ADVISOR_STRATEGY_PLUGIN_ID).get('lastAdvisor'), 'claude-opus-4-8')
  })
})
