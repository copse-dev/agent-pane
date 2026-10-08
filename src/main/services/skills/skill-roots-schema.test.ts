import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { skillRootsSchema } from './skill-roots-schema.ts'

describe('extra skill root boundary', () => {
  it('normalizes and deduplicates absolute roots without changing precedence', () => {
    const first = resolve('skills-a')
    const second = resolve('skills-b')
    assert.deepEqual(skillRootsSchema.parse([` ${first} `, second, first]), [first, second])
    assert.deepEqual(skillRootsSchema.parse([]), [])
  })
  it('rejects untrusted malformed, relative, empty and excessive inputs', () => {
    for (const input of [
      null,
      {},
      ['../skills'],
      [''],
      [123],
      [resolve('bad') + '\0'],
      [resolve('a'.repeat(4097))],
      Array(65).fill(resolve('skills')),
    ]) {
      assert.equal(skillRootsSchema.safeParse(input).success, false)
    }
  })
})
