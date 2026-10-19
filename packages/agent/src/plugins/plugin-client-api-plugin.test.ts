import assert from 'node:assert/strict'
import { it } from 'node:test'
import { PluginRegistry } from './plugin-registry.ts'
import { definePlugin } from './plugin-manifest.ts'
import {
  isPluginClientApiEnabled,
  pluginClientApiPlugin,
  PLUGIN_CLIENT_API_ID,
  PLUGIN_CLIENT_API_CAPABILITY,
} from './plugin-client-api-plugin.ts'

it('requires the owning first-party plugin even when a user plugin declares the same capability', () => {
  const registry = new PluginRegistry()
  const capability = { name: PLUGIN_CLIENT_API_CAPABILITY, title: 'User capability' }
  registry.register(
    definePlugin(
      { name: 'user.same-capability', trust: 'user', capabilities: [capability] },
      { capabilities: [capability] },
    ),
  )
  assert.equal(registry.isCapabilityActive(PLUGIN_CLIENT_API_CAPABILITY), true)
  assert.equal(isPluginClientApiEnabled(registry), false)
  registry.register(pluginClientApiPlugin)
  assert.equal(isPluginClientApiEnabled(registry), true)
  registry.disable(PLUGIN_CLIENT_API_ID)
  assert.equal(registry.isCapabilityActive(PLUGIN_CLIENT_API_CAPABILITY), true)
  assert.equal(isPluginClientApiEnabled(registry), false)
})
