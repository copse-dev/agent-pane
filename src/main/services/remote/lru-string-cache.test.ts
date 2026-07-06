import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LruStringCache } from './lru-string-cache.ts'

describe('LruStringCache', () => {
  it('returns cached values on hit and undefined on miss', () => {
    const cache = new LruStringCache(4, 1024)
    assert.equal(cache.get('a'), undefined)
    cache.set('a', 'alpha')
    assert.equal(cache.get('a'), 'alpha')
  })

  it('evicts the least-recently-used entry when the entry cap is exceeded', () => {
    const cache = new LruStringCache(2, 1024)
    cache.set('a', 'A')
    cache.set('b', 'B')
    cache.set('c', 'C')
    assert.equal(cache.size, 2)
    assert.equal(cache.get('a'), undefined) // oldest evicted
    assert.equal(cache.get('b'), 'B')
    assert.equal(cache.get('c'), 'C')
  })

  it('treats get as a recency bump so a fresh entry is evicted instead', () => {
    const cache = new LruStringCache(2, 1024)
    cache.set('a', 'A')
    cache.set('b', 'B')
    // Touch 'a' so 'b' becomes least-recently-used.
    assert.equal(cache.get('a'), 'A')
    cache.set('c', 'C')
    assert.equal(cache.get('b'), undefined)
    assert.equal(cache.get('a'), 'A')
    assert.equal(cache.get('c'), 'C')
  })

  it('evicts based on total byte size', () => {
    // 10-byte budget; each value is 4 bytes.
    const cache = new LruStringCache(100, 10)
    cache.set('a', '1234')
    cache.set('b', '1234')
    assert.equal(cache.size, 2)
    assert.equal(cache.bytes, 8)
    cache.set('c', '1234') // would be 12 bytes -> evict oldest
    assert.equal(cache.size, 2)
    assert.equal(cache.bytes, 8)
    assert.equal(cache.get('a'), undefined)
  })

  it('updates byte accounting when a key is overwritten', () => {
    const cache = new LruStringCache(10, 1024)
    cache.set('a', 'short')
    cache.set('a', 'a-much-longer-value')
    assert.equal(cache.size, 1)
    assert.equal(cache.bytes, Buffer.byteLength('a-much-longer-value', 'utf8'))
    assert.equal(cache.get('a'), 'a-much-longer-value')
  })

  it('keeps a single value even if it alone exceeds the byte budget', () => {
    const cache = new LruStringCache(10, 4)
    const big = 'this-value-is-way-over-budget'
    cache.set('big', big)
    assert.equal(cache.get('big'), big)
    assert.equal(cache.size, 1)
  })

  it('rejects non-positive bounds', () => {
    assert.throws(() => new LruStringCache(0, 10))
    assert.throws(() => new LruStringCache(10, 0))
  })
})
