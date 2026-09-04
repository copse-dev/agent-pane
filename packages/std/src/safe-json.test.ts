import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decodeWithSchema, safeJsonParse, safeJsonStringify } from './safe-json.ts'

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    assert.deepEqual(safeJsonParse('{"a":1}'), { a: 1 })
    assert.deepEqual(safeJsonParse('[1,2,3]'), [1, 2, 3])
  })

  it('returns null on invalid JSON instead of throwing', () => {
    assert.equal(safeJsonParse('not json'), null)
    assert.equal(safeJsonParse(''), null)
    assert.equal(safeJsonParse('{unterminated'), null)
  })

  it('parses the JSON literal null as null', () => {
    assert.equal(safeJsonParse('null'), null)
  })

  it('uses a decoder before returning a typed result', () => {
    const decodeName = decodeWithSchema({
      safeParse(value: unknown) {
        if (
          typeof value === 'object' &&
          value !== null &&
          'name' in value &&
          typeof value.name === 'string'
        ) {
          return { success: true as const, data: { name: value.name } }
        }
        return { success: false as const }
      },
    })

    assert.deepEqual(safeJsonParse('{"name":"Copse"}', decodeName), { name: 'Copse' })
    assert.equal(safeJsonParse('{"name":42}', decodeName), null)
  })
})

describe('safeJsonStringify', () => {
  it('serializes like JSON.stringify, honouring the indent', () => {
    assert.equal(safeJsonStringify({ a: 1 }), '{"a":1}')
    assert.equal(safeJsonStringify({ a: 1 }, 2), '{\n  "a": 1\n}')
  })

  // The whole point of the wrapper: the lib types this as `string`, so callers
  // that handle the undefined cases look like dead code to the type checker.
  it('reports the values that have no JSON representation', () => {
    assert.equal(safeJsonStringify(undefined), undefined)
    assert.equal(
      safeJsonStringify(() => 1),
      undefined,
    )
    assert.equal(safeJsonStringify(Symbol('s')), undefined)
  })

  it('still throws on a cycle — that is a call-site bug, not a value', () => {
    const cycle: Record<string, unknown> = {}
    cycle['self'] = cycle
    assert.throws(() => safeJsonStringify(cycle))
  })
})
