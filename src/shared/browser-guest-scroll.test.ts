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

  it('answers null for malformed answers, so the caller keeps its last position', () => {
    assert.equal(parseGuestScrollPosition(undefined), null)
    assert.equal(parseGuestScrollPosition(null), null)
    assert.equal(parseGuestScrollPosition('120,480'), null)
    assert.equal(parseGuestScrollPosition({ x: 10 }), null)
    assert.equal(parseGuestScrollPosition({ x: '10', y: 5 }), null)
    assert.equal(parseGuestScrollPosition({ x: Number.NaN, y: 5 }), null)
    assert.equal(parseGuestScrollPosition({ x: Number.POSITIVE_INFINITY, y: 5 }), null)
  })

  it('keeps a negative scrollX (right-to-left pages) without dropping Y', () => {
    assert.deepEqual(parseGuestScrollPosition({ x: -240, y: 800 }), { x: -240, y: 800 })
  })

  it('clamps absurd offsets instead of rejecting them', () => {
    assert.deepEqual(parseGuestScrollPosition({ x: 9_999_999, y: 2 }), { x: 1_000_000, y: 2 })
    assert.deepEqual(parseGuestScrollPosition({ x: -9_999_999, y: 2 }), { x: -1_000_000, y: 2 })
  })
})

describe('GUEST_SCROLL_SCRIPT', () => {
  it('is a self-contained expression that reads the window scroll', () => {
    assert.match(GUEST_SCROLL_SCRIPT, /window\.scrollX/)
    assert.match(GUEST_SCROLL_SCRIPT, /window\.scrollY/)
    assert.match(GUEST_SCROLL_SCRIPT, /^\(.*\)\(\)$/s)
  })
})
