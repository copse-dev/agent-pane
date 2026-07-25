import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_UI_SCALE,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  clampUiScale,
  normalizeUiScale,
  scaledEditorFontSize,
  stepUiScale,
} from './ui-scale.ts'

describe('ui-scale', () => {
  it('clamps to the allowed range and snaps to two decimals', () => {
    assert.equal(clampUiScale(0.5), UI_SCALE_MIN)
    assert.equal(clampUiScale(2), UI_SCALE_MAX)
    assert.equal(clampUiScale(1.234), 1.23)
    assert.equal(clampUiScale(Number.NaN), DEFAULT_UI_SCALE)
  })

  it('normalizes unknown values to the default', () => {
    assert.equal(normalizeUiScale(undefined), DEFAULT_UI_SCALE)
    assert.equal(normalizeUiScale('1.2'), DEFAULT_UI_SCALE)
    assert.equal(normalizeUiScale(1.2), 1.2)
  })

  it('steps by 0.1 without leaving the range', () => {
    assert.equal(stepUiScale(1, 1), 1.1)
    assert.equal(stepUiScale(1, -1), 0.9)
    assert.equal(stepUiScale(UI_SCALE_MAX, 1), UI_SCALE_MAX)
    assert.equal(stepUiScale(UI_SCALE_MIN, -1), UI_SCALE_MIN)
  })

  it('scales editor font sizes and keeps a readable floor', () => {
    assert.equal(scaledEditorFontSize(14, 1), 14)
    assert.equal(scaledEditorFontSize(14, 1.25), 18)
    assert.equal(scaledEditorFontSize(12, 0.75), 9)
    assert.equal(scaledEditorFontSize(8, 0.75), 8)
  })
})
