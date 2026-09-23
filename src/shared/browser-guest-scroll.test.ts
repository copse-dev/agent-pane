import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GUEST_SCROLL_SCRIPT, parseGuestScrollPosition } from './browser-guest-scroll.ts'

describe('parseGuestScrollPosition', () => {
  it('passes through a well-formed position', () => {
    assert.deepEqual(parseGuestScrollPosition({ x: 120, y: 480.5 }), { x: 120, y: 480.5 })
  })

  it('accepts zero offsets', () => {
    assert.deepEqual(parseGuestScrollPosition({ x: 0, y: 0 }), { x: 0, y: 0 })
  })

  it('falls back to no scroll for malformed answers', () => {
    const origin = { x: 0, y: 0 }
    assert.deepEqual(parseGuestScrollPosition(undefined), origin)
    assert.deepEqual(parseGuestScrollPosition(null), origin)
    assert.deepEqual(parseGuestScrollPosition('120,480'), origin)
    assert.deepEqual(parseGuestScrollPosition({ x: 10 }), origin)
    assert.deepEqual(parseGuestScrollPosition({ x: '10', y: 5 }), origin)
    assert.deepEqual(parseGuestScrollPosition({ x: Number.NaN, y: 5 }), origin)
    assert.deepEqual(parseGuestScrollPosition({ x: Number.POSITIVE_INFINITY, y: 5 }), origin)
    assert.deepEqual(parseGuestScrollPosition({ x: -1, y: 5 }), origin)
  })

  it('clamps absurd offsets instead of rejecting them', () => {
    assert.deepEqual(parseGuestScrollPosition({ x: 9_999_999, y: 2 }), { x: 1_000_000, y: 2 })
  })
})

describe('GUEST_SCROLL_SCRIPT', () => {
  it('is a self-contained expression that reads the window scroll', () => {
    assert.match(GUEST_SCROLL_SCRIPT, /window\.scrollX/)
    assert.match(GUEST_SCROLL_SCRIPT, /window\.scrollY/)
    assert.match(GUEST_SCROLL_SCRIPT, /^\(.*\)\(\)$/s)
  })
})
