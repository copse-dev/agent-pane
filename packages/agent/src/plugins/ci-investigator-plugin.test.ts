// Contract test: the `copse.ci-investigator` first-party plugin.
//
// Landing invariants pinned here (mirrors model-comparison-plugin.test.ts):
//
// 1. **The plugin is registered** in `FIRST_PARTY_PLUGINS` with id
//    `copse.ci-investigator` and trust `first-party`, and its manifest +
//    contributions declare all three native tools (`gh_run_list`,
//    `gh_run_view`, `investigate_ci`).
// 2. **No double-registration.** Historically the tools were gated by the
//    top-level `ciInvestigatorEnabled` boolean, which is deleted in the same
//    change (`registry-bootstrap.ts` no longer imports it; the
//    `settings-writable.ts` schema no longer accepts it) — the plugin registry is
//    the single source of truth. This test scans the shipped seed and asserts
//    each tool name appears exactly once in `activeToolNames()` (i.e. only the
//    plugin contributes it), and that no async/blocking hooks are contributed
//    under this plugin id.
// 3. **Atomicity of disable.** One flag flip drops all three tools from
//    `activeToolNames()`; the host tool-registry sync (`syncCiInvestigatorTools`
//    in `registry-bootstrap.ts`) reads the same plugin registry and unregisters
//    the concrete tool objects on toggle (ANDing `gh` availability into the
//    register direction). Plugin storage survives the disable (decision 17).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ciInvestigatorPlugin,
  CI_INVESTIGATOR_PLUGIN_ID,
  CI_INVESTIGATOR_PLUGIN_TOOL_NAMES,
} from './ci-investigator-plugin.ts'
import { createFirstPartyPluginRegistry, FIRST_PARTY_PLUGINS } from './first-party-plugins.ts'

const TOOL_NAMES = [...CI_INVESTIGATOR_PLUGIN_TOOL_NAMES]

describe('copse.ci-investigator plugin', () => {
  it('is registered in FIRST_PARTY_PLUGINS with id copse.ci-investigator', () => {
    assert.equal(ciInvestigatorPlugin.id, CI_INVESTIGATOR_PLUGIN_ID)
    assert.equal(ciInvestigatorPlugin.trust, 'first-party')
    assert.ok(
      FIRST_PARTY_PLUGINS.some((plugin) => plugin.id === CI_INVESTIGATOR_PLUGIN_ID),
      'ci-investigator plugin must be part of the shipped first-party plugin list',
    )
  })

  it('declares the three CI tools, namespaced storage, and no hook contributions', () => {
    assert.deepEqual(ciInvestigatorPlugin.manifest.tools?.native, TOOL_NAMES)
    assert.deepEqual(ciInvestigatorPlugin.manifest.storage, {
      namespace: CI_INVESTIGATOR_PLUGIN_ID,
    })
    assert.deepEqual(ciInvestigatorPlugin.contributions.toolNames, TOOL_NAMES)
    // The tools are inline registration sites, not static hooks, so the plugin
    // contributes nothing to the function-hook lists. Pinning this shape makes
    // any accidental double-registration regression a mechanical failure.
    assert.deepEqual(ciInvestigatorPlugin.contributions.blockingHooks, [])
    assert.deepEqual(ciInvestigatorPlugin.contributions.asyncHooks, [])
    assert.deepEqual(ciInvestigatorPlugin.contributions.promptBlocks, [])
    assert.deepEqual(ciInvestigatorPlugin.contributions.uiContributions, [])
  })

  it('contributes each CI tool exactly once across all first-party plugins', () => {
    // Across the whole shipped seed no other plugin contributes these tool names
    // — otherwise the tool registration in `registry-bootstrap.ts` would be
    // ambiguous once tools are read through the plugin registry.
    const allToolNames = FIRST_PARTY_PLUGINS.flatMap((plugin) => plugin.contributions.toolNames)
    for (const name of TOOL_NAMES) {
      assert.equal(
        allToolNames.filter((n) => n === name).length,
        1,
        `${name} must be contributed by exactly one plugin`,
      )
    }
  })

  it('atomically drops every tool from the active seed on disable', () => {
    const registry = createFirstPartyPluginRegistry()
    assert.equal(registry.isEnabled(CI_INVESTIGATOR_PLUGIN_ID), true)
    for (const name of TOOL_NAMES) {
      assert.ok(registry.activeToolNames().includes(name), `${name} active while enabled`)
    }

    // Plugin storage survives disable (decision 17).
    registry.storage(CI_INVESTIGATOR_PLUGIN_ID).set('lastRun', 'r-1')

    registry.disable(CI_INVESTIGATOR_PLUGIN_ID)
    assert.equal(registry.isEnabled(CI_INVESTIGATOR_PLUGIN_ID), false)
    for (const name of TOOL_NAMES) {
      assert.ok(
        !registry.activeToolNames().includes(name),
        `${name} must leave activeToolNames() the moment the plugin is disabled`,
      )
    }

    registry.enable(CI_INVESTIGATOR_PLUGIN_ID)
    for (const name of TOOL_NAMES) {
      assert.ok(registry.activeToolNames().includes(name), `${name} restored on re-enable`)
    }
    assert.equal(registry.storage(CI_INVESTIGATOR_PLUGIN_ID).get('lastRun'), 'r-1')
  })
})
