import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  clampUiScale,
  DEFAULT_UI_SCALE,
  parseUiScale,
  scaledEditorFontSize,
  stepUiScale,
  uiScaleLabel,
} from './ui-scale.ts'

describe('ui-scale', () => {
  it('clampUiScale snaps to 5% steps within bounds', () => {
    assert.equal(clampUiScale(1), 1)
    assert.equal(clampUiScale(1.03), 1.05)
    assert.equal(clampUiScale(0.8), 0.85)
    assert.equal(clampUiScale(1.4), 1.35)
  })

  it('parseUiScale falls back to default for invalid input', () => {
    assert.equal(parseUiScale(undefined), DEFAULT_UI_SCALE)
    assert.equal(parseUiScale('1'), DEFAULT_UI_SCALE)
    assert.equal(parseUiScale(1.1), 1.1)
  })

  it('stepUiScale steps and resets', () => {
    assert.equal(stepUiScale(1, 'in'), 1.05)
    assert.equal(stepUiScale(1.05, 'out'), 1)
    assert.equal(stepUiScale(1.2, 'reset'), DEFAULT_UI_SCALE)
  })

  it('scaledEditorFontSize multiplies and rounds', () => {
    assert.equal(scaledEditorFontSize(14, 1), 14)
    assert.equal(scaledEditorFontSize(14, 1.1), 15)
  })

  it('uiScaleLabel formats percentages', () => {
    assert.equal(uiScaleLabel(1), '100%')
    assert.equal(uiScaleLabel(1.1), '110%')
  })
})
