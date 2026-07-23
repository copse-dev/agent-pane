import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { applyUiScale, restoreUiScale } from './ui-scale.ts'
import { DEFAULT_UI_SCALE } from '@shared/ui-scale.ts'

describe('applyUiScale', () => {
  beforeEach(() => {
    applyUiScale(DEFAULT_UI_SCALE)
  })

  it('writes a clamped --ui-scale on the document element', () => {
    applyUiScale(1.25)
    assert.equal(document.documentElement.style.getPropertyValue('--ui-scale'), '1.25')
    applyUiScale(3)
    assert.equal(document.documentElement.style.getPropertyValue('--ui-scale'), '1.5')
  })

  it('restores a persisted value or the default', () => {
    assert.equal(restoreUiScale(1.1), 1.1)
    assert.equal(document.documentElement.style.getPropertyValue('--ui-scale'), '1.1')
    assert.equal(restoreUiScale('nope'), DEFAULT_UI_SCALE)
  })
})
