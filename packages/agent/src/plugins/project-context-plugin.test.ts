import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EXPERIMENTAL_FIRST_PARTY_PLUGIN_IDS,
  createFirstPartyPluginRegistry,
} from './first-party-plugins.ts'
import { PROJECT_CONTEXT_PLUGIN_ID, PROJECT_CONTEXT_TOOL_NAMES } from './project-context-plugin.ts'

test('project context ships as an opt-in experiment with native-only tools', () => {
  assert.ok(EXPERIMENTAL_FIRST_PARTY_PLUGIN_IDS.includes(PROJECT_CONTEXT_PLUGIN_ID))
  const registry = createFirstPartyPluginRegistry()
  for (const name of PROJECT_CONTEXT_TOOL_NAMES) {
    assert.ok(registry.activeToolNames().includes(name))
    assert.equal(registry.activeAcpToolNames().includes(name), false)
  }
  registry.disable(PROJECT_CONTEXT_PLUGIN_ID)
  for (const name of PROJECT_CONTEXT_TOOL_NAMES)
    assert.equal(registry.activeToolNames().includes(name), false)
})
