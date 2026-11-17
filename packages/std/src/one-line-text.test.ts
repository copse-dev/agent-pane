import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { collapseWhitespace, ellipsize, truncateLine } from './one-line-text.ts'

describe('collapseWhitespace', () => {
  it('folds every whitespace run, newlines and tabs included, into one space and trims', () => {
    assert.equal(collapseWhitespace('  a\n\n b\t\tc  '), 'a b c')
    assert.equal(collapseWhitespace(' x y\r\n'), 'x y')
    assert.equal(collapseWhitespace('   '), '')
  })
})

describe('ellipsize', () => {
  it('returns text that fits unchanged, including at exactly max', () => {
    assert.equal(ellipsize('abc', 3), 'abc')
    assert.equal(ellipsize('', 0), '')
  })

  it('cuts to max - 1 characters plus the ellipsis, so the result is max long', () => {
    assert.equal(ellipsize('abcdef', 4), 'abc…')
    assert.equal(ellipsize('abcdef', 4).length, 4)
    assert.equal(ellipsize('abcdef', 1), '…')
  })

  it('keeps whitespace at the cut unless trimEnd is set', () => {
    assert.equal(ellipsize('ab  cdef', 5), 'ab  …')
    assert.equal(ellipsize('ab  cdef', 5, { trimEnd: true }), 'ab…')
  })
})

describe('truncateLine', () => {
  it('collapses whitespace before measuring', () => {
    assert.equal(truncateLine('a\n\nb', 3), 'a b')
    assert.equal(truncateLine('one\n two three', 8), 'one two…')
  })
})
