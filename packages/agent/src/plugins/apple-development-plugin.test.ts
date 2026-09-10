import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  APPLE_DEVELOPMENT_PANEL_ID,
  APPLE_DEVELOPMENT_PLUGIN_ID,
  appleDevelopmentPlugin,
} from './apple-development-plugin.ts'
import { createFirstPartyPluginRegistry, FIRST_PARTY_PLUGINS } from './first-party-plugins.ts'

describe('Apple Development plugin', () => {
  it('ships as an experimental first-party pack backed by bundled MCP tools', () => {
    assert.equal(appleDevelopmentPlugin.id, APPLE_DEVELOPMENT_PLUGIN_ID)
    assert.equal(appleDevelopmentPlugin.trust, 'first-party')
    assert.equal(appleDevelopmentPlugin.manifest.stability, 'experimental')
    assert.equal(appleDevelopmentPlugin.manifest.tools, undefined)
    assert.deepEqual(appleDevelopmentPlugin.contributions.toolNames, [])
    assert.ok(FIRST_PARTY_PLUGINS.includes(appleDevelopmentPlugin))
  })

  it('declares shipped setup and thread views and drops them on disable', () => {
    assert.deepEqual(
      appleDevelopmentPlugin.contributions.uiContributions.map((contribution) => contribution.id),
      [APPLE_DEVELOPMENT_PANEL_ID, 'apple-development-setup'],
    )
    const registry = createFirstPartyPluginRegistry()
    assert.equal(
      registry
        .activeUiContributions()
        .some(({ id }) => id === APPLE_DEVELOPMENT_PANEL_ID || id === 'apple-development-setup'),
      true,
    )
    registry.disable(APPLE_DEVELOPMENT_PLUGIN_ID)
    assert.equal(
      registry
        .activeUiContributions()
        .some(({ id }) => id === APPLE_DEVELOPMENT_PANEL_ID || id === 'apple-development-setup'),
      false,
    )
  })
})
