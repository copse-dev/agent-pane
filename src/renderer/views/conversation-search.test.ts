import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { findMatchOffsets } from './conversation-search.ts'

describe('findMatchOffsets', () => {
  it('finds every occurrence, case-insensitively', () => {
    assert.deepEqual(findMatchOffsets('Foo foo FOO', 'foo'), [0, 4, 8])
  })

  it('returns an empty list for an empty needle', () => {
    assert.deepEqual(findMatchOffsets('anything', ''), [])
  })

  it('returns an empty list when there is no match', () => {
    assert.deepEqual(findMatchOffsets('hello world', 'xyz'), [])
  })

  it('advances past each match so overlaps are not double-counted', () => {
    // "aa" in "aaaa" yields non-overlapping matches at 0 and 2, mirroring find.
    assert.deepEqual(findMatchOffsets('aaaa', 'aa'), [0, 2])
  })

  it('matches across word boundaries and punctuation', () => {
    assert.deepEqual(findMatchOffsets('cmd+f, cmd+f!', 'cmd+f'), [0, 7])
  })
})
