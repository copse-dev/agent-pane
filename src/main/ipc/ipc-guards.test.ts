import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { INDEX_QUERY_PATTERN, isIndexQueryPattern } from './ipc-guards.ts'

describe('ipc-guards index query', () => {
  it('accepts normal search substrings', () => {
    assert.match('foo-bar.ts', INDEX_QUERY_PATTERN)
    assert.equal(isIndexQueryPattern('foo-bar.ts'), true)
  })

  it('rejects glob metacharacters', () => {
    assert.equal(isIndexQueryPattern('{a,b}'), false)
    assert.equal(isIndexQueryPattern('**'), false)
  })
})
