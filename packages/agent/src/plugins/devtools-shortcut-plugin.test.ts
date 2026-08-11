// Contract test: the `copse.devtools-shortcut` first-party plugin.
//
// Landing invariants pinned here (mirrors mcp-ui-canvas-plugin.test.ts):
//
// 1. **The plugin is registered** in `FIRST_PARTY_PLUGINS` with id
//    `copse.devtools-shortcut` and trust `first-party`, and its manifest +
//    contributions declare the `devtools-shortcut` capability and NO tool/hook/
//    prompt/ui (it is a pure behaviour flag).
// 2. **Single owner.** Across the shipped seed the `devtools-shortcut`
//    capability is declared exactly once, so the host read site
//    (`create-main-window.ts` `syncDevtoolsShortcut`) resolves it unambiguously
//    through `isCapabilityActive`.
// 3. **Atomicity of disable.** One flag flip drops the capability from
//    `isCapabilityActive('devtools-shortcut')`. The default-OFF product
//    behaviour is enforced by the plugin-service enablement migration, not the raw
//    registry seed, so this test toggles enablement explicitly.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  devtoolsShortcutPlugin,
  DEVTOOLS_SHORTCUT_PLUGIN_ID,
  DEVTOOLS_SHORTCUT_CAPABILITY,
} from './devtools-shortcut-plugin.ts'
import { createFirstPartyPluginRegistry, FIRST_PARTY_PLUGINS } from './first-party-plugins.ts'

describe('copse.devtools-shortcut plugin', () => {
  it('is registered in FIRST_PARTY_PLUGINS with id copse.devtools-shortcut', () => {
    assert.equal(devtoolsShortcutPlugin.id, DEVTOOLS_SHORTCUT_PLUGIN_ID)
    assert.equal(devtoolsShortcutPlugin.trust, 'first-party')
    assert.ok(
      FIRST_PARTY_PLUGINS.some((plugin) => plugin.id === DEVTOOLS_SHORTCUT_PLUGIN_ID),
      'devtools-shortcut plugin must be part of the shipped first-party plugin list',
    )
  })

  it('declares the devtools-shortcut capability and no tool/hook/prompt/ui contributions', () => {
    assert.equal(
      devtoolsShortcutPlugin.manifest.capabilities?.[0]?.name,
      DEVTOOLS_SHORTCUT_CAPABILITY,
    )
    assert.equal(
      devtoolsShortcutPlugin.contributions.capabilities[0]?.name,
      DEVTOOLS_SHORTCUT_CAPABILITY,
    )
    assert.deepEqual(devtoolsShortcutPlugin.contributions.toolNames, [])
    assert.deepEqual(devtoolsShortcutPlugin.contributions.blockingHooks, [])
    assert.deepEqual(devtoolsShortcutPlugin.contributions.asyncHooks, [])
    assert.deepEqual(devtoolsShortcutPlugin.contributions.promptBlocks, [])
    assert.deepEqual(devtoolsShortcutPlugin.contributions.uiContributions, [])
    assert.equal(devtoolsShortcutPlugin.manifest.tools, undefined)
  })

  it('declares devtools-shortcut exactly once across all first-party plugins', () => {
    const occurrences = FIRST_PARTY_PLUGINS.flatMap((plugin) =>
      plugin.contributions.capabilities.map((c) => c.name),
    ).filter((name) => name === DEVTOOLS_SHORTCUT_CAPABILITY)
    assert.equal(occurrences.length, 1)
  })

  it('atomically drops the capability on disable', () => {
    const registry = createFirstPartyPluginRegistry()
    assert.equal(registry.isEnabled(DEVTOOLS_SHORTCUT_PLUGIN_ID), true)
    assert.equal(registry.isCapabilityActive(DEVTOOLS_SHORTCUT_CAPABILITY), true)

    registry.disable(DEVTOOLS_SHORTCUT_PLUGIN_ID)
    assert.equal(registry.isEnabled(DEVTOOLS_SHORTCUT_PLUGIN_ID), false)
    assert.equal(
      registry.isCapabilityActive(DEVTOOLS_SHORTCUT_CAPABILITY),
      false,
      'devtools-shortcut must leave isCapabilityActive() the moment the plugin is disabled',
    )

    registry.enable(DEVTOOLS_SHORTCUT_PLUGIN_ID)
    assert.equal(registry.isCapabilityActive(DEVTOOLS_SHORTCUT_CAPABILITY), true)
  })
})
