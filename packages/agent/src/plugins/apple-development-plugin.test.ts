import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  APPLE_DEVELOPMENT_PANEL_ID,
  APPLE_DEVELOPMENT_PLUGIN_ID,
  APPLE_DEVELOPMENT_TOOL_NAMES,
  appleDevelopmentPlugin,
} from './apple-development-plugin.ts'
import { createFirstPartyPluginRegistry, FIRST_PARTY_PLUGINS } from './first-party-plugins.ts'

describe('Apple Development plugin', () => {
  it('ships as an experimental first-party pack with shared native and ACP tools', () => {
    assert.equal(appleDevelopmentPlugin.id, APPLE_DEVELOPMENT_PLUGIN_ID)
    assert.equal(appleDevelopmentPlugin.trust, 'first-party')
    assert.equal(appleDevelopmentPlugin.manifest.stability, 'experimental')
    const { tools } = appleDevelopmentPlugin.manifest
    assert.ok(tools)
    assert.deepEqual(tools.native, APPLE_DEVELOPMENT_TOOL_NAMES)
    assert.deepEqual(tools.acpTools, APPLE_DEVELOPMENT_TOOL_NAMES)
    assert.deepEqual(appleDevelopmentPlugin.contributions.toolNames, APPLE_DEVELOPMENT_TOOL_NAMES)
    assert.ok(FIRST_PARTY_PLUGINS.includes(appleDevelopmentPlugin))
  })

  it('declares shipped setup and thread views and drops all contributions on disable', () => {
    assert.deepEqual(
      appleDevelopmentPlugin.contributions.uiContributions.map((contribution) => contribution.id),
      [APPLE_DEVELOPMENT_PANEL_ID, 'apple-development-setup'],
    )
    const registry = createFirstPartyPluginRegistry()
    for (const name of APPLE_DEVELOPMENT_TOOL_NAMES) {
      assert.equal(registry.activeToolNames().includes(name), true)
    }
    registry.disable(APPLE_DEVELOPMENT_PLUGIN_ID)
    for (const name of APPLE_DEVELOPMENT_TOOL_NAMES) {
      assert.equal(registry.activeToolNames().includes(name), false)
    }
    assert.equal(
      registry
        .activeUiContributions()
        .some(({ id }) => id === APPLE_DEVELOPMENT_PANEL_ID || id === 'apple-development-setup'),
      false,
    )
  })
})
