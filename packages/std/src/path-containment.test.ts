import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join, sep } from 'node:path'
import { isPathWithin, relativeWithin } from './path-containment.ts'

const root = join(sep, 'a', 'b')

describe('relativeWithin', () => {
  it('returns an empty path for the root itself', () => {
    assert.equal(relativeWithin(root, root), '')
    assert.equal(relativeWithin(`${root}${sep}`, root), '')
  })

  it('returns the relative path of a descendant', () => {
    assert.equal(relativeWithin(root, join(root, 'c')), 'c')
    assert.equal(relativeWithin(root, join(root, 'c', 'd')), join('c', 'd'))
  })

  it('resolves dot segments before comparing', () => {
    assert.equal(relativeWithin(root, join(root, 'c', '..', 'd')), 'd')
    assert.equal(relativeWithin(root, `${root}${sep}c${sep}..${sep}..${sep}x`), null)
  })

  it('rejects a sibling that shares a string prefix', () => {
    assert.equal(relativeWithin(root, join(sep, 'a', 'bc')), null)
    assert.equal(relativeWithin(root, join(sep, 'a', 'b.bak', 'c')), null)
  })

  it('rejects the parent and anything reached through it', () => {
    assert.equal(relativeWithin(root, join(sep, 'a')), null)
    assert.equal(relativeWithin(root, sep), null)
    assert.equal(relativeWithin(root, join(sep, 'a', 'x', 'y')), null)
  })

  it('keeps a child whose name starts with two dots inside', () => {
    assert.equal(relativeWithin(root, join(root, '..foo')), '..foo')
    assert.equal(relativeWithin(root, join(root, '...')), '...')
    assert.equal(relativeWithin(root, join(root, '..foo', 'bar')), join('..foo', 'bar'))
  })

  it('rejects a path on another Windows drive', { skip: process.platform !== 'win32' }, () => {
    assert.equal(relativeWithin('C:\\a', 'D:\\a\\b'), null)
    assert.equal(relativeWithin('C:\\a', 'C:\\a\\b'), 'b')
  })
})

describe('isPathWithin', () => {
  it('counts the root itself by default', () => {
    assert.equal(isPathWithin(root, root), true)
    assert.equal(isPathWithin(root, root, { allowSelf: true }), true)
  })

  it('excludes the root itself when allowSelf is false', () => {
    assert.equal(isPathWithin(root, root, { allowSelf: false }), false)
    assert.equal(isPathWithin(root, `${root}${sep}`, { allowSelf: false }), false)
  })

  it('accepts a descendant either way', () => {
    for (const allowSelf of [true, false]) {
      assert.equal(isPathWithin(root, join(root, 'c'), { allowSelf }), true)
      assert.equal(isPathWithin(root, join(root, '..foo'), { allowSelf }), true)
    }
  })

  it('rejects an escape either way', () => {
    for (const allowSelf of [true, false]) {
      assert.equal(isPathWithin(root, join(sep, 'a', 'bc'), { allowSelf }), false)
      assert.equal(isPathWithin(root, join(sep, 'a'), { allowSelf }), false)
      assert.equal(isPathWithin(root, join(sep, 'z'), { allowSelf }), false)
    }
  })
})
