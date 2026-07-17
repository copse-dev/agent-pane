import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { countPortraitPanelOverflow } from './portrait-panel-bar-overflow.ts'

describe('countPortraitPanelOverflow', () => {
  it('keeps every button when the row fits without an overflow trigger', () => {
    assert.equal(countPortraitPanelOverflow([40, 50, 60], 2, 200, 24), 0)
  })

  it('hides trailing buttons until the visible set plus trigger fits', () => {
    // 40+2+50+2+60+2+70 = 226 without overflow; container 160 → hide two from end.
    assert.equal(countPortraitPanelOverflow([40, 50, 60, 70], 2, 160, 24), 2)
  })

  it('never hides below minVisible', () => {
    assert.equal(countPortraitPanelOverflow([80, 80, 80], 2, 50, 24, 1), 2)
  })

  it('returns 0 for an empty candidate list', () => {
    assert.equal(countPortraitPanelOverflow([], 2, 100, 24), 0)
  })
})
