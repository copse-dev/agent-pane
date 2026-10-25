import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPUTER_USE_PLUGIN_ID,
  COMPUTER_USE_TOOL_NAMES,
  computerUsePlugin,
} from './computer-use-plugin.ts'
import { EXPERIMENTAL_FIRST_PARTY_PLUGIN_IDS, FIRST_PARTY_PLUGINS } from './first-party-plugins.ts'

describe('Computer use plugin', () => {
  it('ships disabled as an experimental first-party plugin', () => {
    assert.equal(computerUsePlugin.id, COMPUTER_USE_PLUGIN_ID)
    assert.equal(computerUsePlugin.trust, 'first-party')
    assert.ok(FIRST_PARTY_PLUGINS.includes(computerUsePlugin))
    assert.ok(EXPERIMENTAL_FIRST_PARTY_PLUGIN_IDS.includes(COMPUTER_USE_PLUGIN_ID))
  })

  it('declares the same desktop tools to native and ACP agents', () => {
    const tools = computerUsePlugin.manifest.tools
    assert.ok(tools)
    assert.deepEqual(tools.native, [...COMPUTER_USE_TOOL_NAMES])
    assert.deepEqual(tools.acpTools, [...COMPUTER_USE_TOOL_NAMES])
    assert.deepEqual(computerUsePlugin.contributions.toolNames, [...COMPUTER_USE_TOOL_NAMES])
  })
})
