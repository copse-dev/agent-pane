import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assertIndexQueryPattern, INDEX_QUERY_PATTERN } from './ipc-guards.ts'

describe('ipc-guards index query', () => {
  it('accepts normal search substrings', () => {
    assert.match('foo-bar.ts', INDEX_QUERY_PATTERN)
    assert.doesNotThrow(() => assertIndexQueryPattern('foo-bar.ts'))
  })

  it('rejects glob metacharacters', () => {
    assert.throws(() => assertIndexQueryPattern('{a,b}'), /Invalid index query/)
    assert.throws(() => assertIndexQueryPattern('**'), /Invalid index query/)
  })
})
