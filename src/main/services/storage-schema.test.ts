import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { parseStored, parseStringList } from './storage-schema.ts'

describe('storage-schema', () => {
  it('parseStored returns parsed value for valid input', () => {
    const schema = z.object({ n: z.number() })
    assert.deepEqual(parseStored(schema, { n: 5 }, { n: 0 }), { n: 5 })
  })

  it('parseStored falls back on corrupt/wrong-typed input without throwing', () => {
    const schema = z.object({ n: z.number() })
    assert.deepEqual(parseStored(schema, { n: 'not-a-number' }, { n: 0 }), { n: 0 })
    assert.deepEqual(parseStored(schema, 'garbage', { n: 0 }), { n: 0 })
    assert.deepEqual(parseStored(schema, null, { n: 0 }), { n: 0 })
    assert.deepEqual(parseStored(schema, undefined, { n: 0 }), { n: 0 })
  })

  it('parseStringList accepts a clean list', () => {
    assert.deepEqual(parseStringList(['a', 'b']), ['a', 'b'])
  })

  it('parseStringList drops non-strings, empties, and dupes for corrupt data', () => {
    // electron-store can hand back a wrong-typed / hand-edited value.
    assert.deepEqual(parseStringList(['a', '', 'a', 'b']), ['a', 'b'])
    assert.deepEqual(parseStringList('not-an-array'), [])
    assert.deepEqual(parseStringList([1, 2, 3]), [])
    assert.deepEqual(parseStringList(null), [])
    assert.deepEqual(parseStringList(undefined), [])
  })
})
