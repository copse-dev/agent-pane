import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createFirstPartyPackRegistry, FIRST_PARTY_PACKS } from './first-party-packs.ts'
import { siteBuildingPack, SITE_BUILDING_PACK_ID } from './site-building-pack.ts'
import { siteBuildingSteeringHook, TURN_START_HOOKS } from '../hooks/turn-start-hooks.ts'

describe('copse.site-building pack', () => {
  it('ships as a stable first-party pack with one conditional hook', () => {
    assert.equal(siteBuildingPack.id, SITE_BUILDING_PACK_ID)
    assert.equal(siteBuildingPack.manifest.trust, 'first-party')
    assert.equal(siteBuildingPack.manifest.stability, 'stable')
    assert.ok(FIRST_PARTY_PACKS.some((pack) => pack.id === SITE_BUILDING_PACK_ID))
    assert.deepEqual(siteBuildingPack.contributions.blockingHooks, [siteBuildingSteeringHook])
    assert.deepEqual(siteBuildingPack.contributions.toolNames, [])
    assert.deepEqual(siteBuildingPack.contributions.promptBlocks, [])
    assert.deepEqual(siteBuildingPack.contributions.uiContributions, [])
  })

  it('registers the hook exactly once through the pack', () => {
    assert.ok(!TURN_START_HOOKS.some((hook) => hook.id === siteBuildingSteeringHook.id))
    const occurrences = FIRST_PARTY_PACKS.flatMap((pack) =>
      pack.contributions.blockingHooks.map((hook) => hook.id),
    ).filter((id) => id === siteBuildingSteeringHook.id)
    assert.equal(occurrences.length, 1)
  })

  it('atomically removes and restores the hook while preserving storage', () => {
    const registry = createFirstPartyPackRegistry()
    assert.ok(
      registry.activeBlockingHooks().some((hook) => hook.id === siteBuildingSteeringHook.id),
    )
    registry.storage(SITE_BUILDING_PACK_ID).set('example', 'kept')

    registry.disable(SITE_BUILDING_PACK_ID)
    assert.ok(
      !registry.activeBlockingHooks().some((hook) => hook.id === siteBuildingSteeringHook.id),
    )

    registry.enable(SITE_BUILDING_PACK_ID)
    assert.ok(
      registry.activeBlockingHooks().some((hook) => hook.id === siteBuildingSteeringHook.id),
    )
    assert.equal(registry.storage(SITE_BUILDING_PACK_ID).get('example'), 'kept')
  })
})
