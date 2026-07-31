import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { packModelValue, parsePackModelSelection } from './pack-model.ts'

describe('pack model selection', () => {
  it('round-trips pack and route ids without delimiter collisions', () => {
    const value = packModelValue('personal.pack:one', 'judge:default')
    assert.equal(value, 'pack-model:personal.pack%3Aone:judge%3Adefault')
    assert.deepEqual(parsePackModelSelection(value), {
      packId: 'personal.pack:one',
      routeId: 'judge:default',
    })
  })

  it('fails closed on malformed selections', () => {
    assert.equal(parsePackModelSelection('pack-model:missing-route'), null)
    assert.equal(parsePackModelSelection('pack-model:%E0%A4%A:route'), null)
    assert.equal(parsePackModelSelection('gpt-4o'), null)
  })
})
