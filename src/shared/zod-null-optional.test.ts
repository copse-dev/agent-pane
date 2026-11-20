import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { nullAsUndefined, optionalNumber, optionalString } from './zod-null-optional.ts'

describe('optionalString / optionalNumber', () => {
  it('parse null and a missing field as undefined', () => {
    const schema = z.object({ name: optionalString, count: optionalNumber })
    assert.deepEqual(schema.parse({ name: null, count: null }), {
      name: undefined,
      count: undefined,
    })
    assert.deepEqual(schema.parse({}), {})
  })

  it('keep a present value of the right type', () => {
    assert.equal(optionalString.parse('x'), 'x')
    assert.equal(optionalString.parse(''), '')
    assert.equal(optionalNumber.parse(0), 0)
  })

  it('still reject a value of the wrong type', () => {
    assert.equal(optionalString.safeParse(1).success, false)
    assert.equal(optionalNumber.safeParse('1').success, false)
  })
})

describe('nullAsUndefined', () => {
  it('folds null into undefined for any optional schema', () => {
    const author = nullAsUndefined(z.object({ login: optionalString }).optional())
    assert.equal(author.parse(null), undefined)
    assert.deepEqual(author.parse({ login: null }), { login: undefined })
  })

  it('leaves a required schema rejecting null', () => {
    assert.equal(nullAsUndefined(z.string()).safeParse(null).success, false)
  })
})
