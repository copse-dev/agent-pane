import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFirstPartyPluginRegistry, FIRST_PARTY_PLUGINS } from './first-party-plugins.ts'
import {
  REVIEWER_INPUT_PLUGIN_ID,
  REVIEWER_INPUT_TOOL_NAME,
  reviewerInputPlugin,
} from './reviewer-input-plugin.ts'

test('reviewer input is a first-party experiment whose tool disappears on disable', () => {
  assert.equal(reviewerInputPlugin.manifest.stability, 'experimental')
  const declaredTools = reviewerInputPlugin.manifest.tools
  assert.ok(declaredTools)
  assert.deepEqual(declaredTools.native, [REVIEWER_INPUT_TOOL_NAME])
  assert.deepEqual(declaredTools.acpTools, [REVIEWER_INPUT_TOOL_NAME])
  assert.equal(
    FIRST_PARTY_PLUGINS.some((plugin) => plugin.id === REVIEWER_INPUT_PLUGIN_ID),
    true,
  )
  const registry = createFirstPartyPluginRegistry()
  assert.equal(registry.activeToolNames().includes(REVIEWER_INPUT_TOOL_NAME), true)
  assert.equal(registry.activeAcpToolNames().includes(REVIEWER_INPUT_TOOL_NAME), true)
  registry.disable(REVIEWER_INPUT_PLUGIN_ID)
  assert.equal(registry.activeToolNames().includes(REVIEWER_INPUT_TOOL_NAME), false)
  assert.equal(registry.activeAcpToolNames().includes(REVIEWER_INPUT_TOOL_NAME), false)
})
