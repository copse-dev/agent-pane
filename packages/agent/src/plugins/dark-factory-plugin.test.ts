import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FIRST_PARTY_PLUGINS } from './first-party-plugins.ts'
import { DARK_FACTORY_PLUGIN_ID, darkFactoryPlugin } from './dark-factory-plugin.ts'

describe('dark-factory plugin', () => {
  it('ships as an experimental contribution-free lifecycle gate', () => {
    assert.equal(darkFactoryPlugin.id, DARK_FACTORY_PLUGIN_ID)
    assert.equal(darkFactoryPlugin.manifest.stability, 'experimental')
    assert.ok(FIRST_PARTY_PLUGINS.some((plugin) => plugin.id === DARK_FACTORY_PLUGIN_ID))
    assert.deepEqual(darkFactoryPlugin.contributions.toolNames, [])
    assert.deepEqual(darkFactoryPlugin.contributions.blockingHooks, [])
    assert.deepEqual(darkFactoryPlugin.contributions.asyncHooks, [])
  })
})
