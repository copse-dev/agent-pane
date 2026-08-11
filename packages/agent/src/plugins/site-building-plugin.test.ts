import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createFirstPartyPluginRegistry, FIRST_PARTY_PLUGINS } from './first-party-plugins.ts'
import { siteBuildingPlugin, SITE_BUILDING_PLUGIN_ID } from './site-building-plugin.ts'
import { siteBuildingSteeringHook, TURN_START_HOOKS } from '../hooks/turn-start-hooks.ts'

describe('copse.site-building plugin', () => {
  it('ships as a stable first-party plugin with one conditional hook', () => {
    assert.equal(siteBuildingPlugin.id, SITE_BUILDING_PLUGIN_ID)
    assert.equal(siteBuildingPlugin.manifest.trust, 'first-party')
    assert.equal(siteBuildingPlugin.manifest.stability, 'stable')
    assert.ok(FIRST_PARTY_PLUGINS.some((plugin) => plugin.id === SITE_BUILDING_PLUGIN_ID))
    assert.deepEqual(siteBuildingPlugin.contributions.blockingHooks, [siteBuildingSteeringHook])
    assert.deepEqual(siteBuildingPlugin.contributions.toolNames, [])
    assert.deepEqual(siteBuildingPlugin.contributions.promptBlocks, [])
    assert.deepEqual(siteBuildingPlugin.contributions.uiContributions, [])
  })

  it('registers the hook exactly once through the plugin', () => {
    assert.ok(!TURN_START_HOOKS.some((hook) => hook.id === siteBuildingSteeringHook.id))
    const occurrences = FIRST_PARTY_PLUGINS.flatMap((plugin) =>
      plugin.contributions.blockingHooks.map((hook) => hook.id),
    ).filter((id) => id === siteBuildingSteeringHook.id)
    assert.equal(occurrences.length, 1)
  })

  it('atomically removes and restores the hook while preserving storage', () => {
    const registry = createFirstPartyPluginRegistry()
    assert.ok(
      registry.activeBlockingHooks().some((hook) => hook.id === siteBuildingSteeringHook.id),
    )
    registry.storage(SITE_BUILDING_PLUGIN_ID).set('example', 'kept')

    registry.disable(SITE_BUILDING_PLUGIN_ID)
    assert.ok(
      !registry.activeBlockingHooks().some((hook) => hook.id === siteBuildingSteeringHook.id),
    )

    registry.enable(SITE_BUILDING_PLUGIN_ID)
    assert.ok(
      registry.activeBlockingHooks().some((hook) => hook.id === siteBuildingSteeringHook.id),
    )
    assert.equal(registry.storage(SITE_BUILDING_PLUGIN_ID).get('example'), 'kept')
  })
})
