import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FIRST_PARTY_PACKS } from './first-party-packs.ts'
import { DARK_FACTORY_PACK_ID, darkFactoryPack } from './dark-factory-pack.ts'

describe('dark-factory pack', () => {
  it('ships as an experimental contribution-free lifecycle gate', () => {
    assert.equal(darkFactoryPack.id, DARK_FACTORY_PACK_ID)
    assert.equal(darkFactoryPack.manifest.stability, 'experimental')
    assert.ok(FIRST_PARTY_PACKS.some((pack) => pack.id === DARK_FACTORY_PACK_ID))
    assert.deepEqual(darkFactoryPack.contributions.toolNames, [])
    assert.deepEqual(darkFactoryPack.contributions.blockingHooks, [])
    assert.deepEqual(darkFactoryPack.contributions.asyncHooks, [])
  })
})
