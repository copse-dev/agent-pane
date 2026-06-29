import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { promptProgressLabel } from './agent-activity.ts'

describe('promptProgressLabel', () => {
  it('is indeterminate when no fraction is reported', () => {
    assert.equal(promptProgressLabel(undefined), 'Processing prompt…')
  })

  it('renders a rounded percentage when a fraction is reported', () => {
    assert.equal(promptProgressLabel(0), 'Processing prompt… 0%')
    assert.equal(promptProgressLabel(0.47), 'Processing prompt… 47%')
    assert.equal(promptProgressLabel(1), 'Processing prompt… 100%')
  })

  it('clamps out-of-range and ignores non-finite values', () => {
    assert.equal(promptProgressLabel(1.5), 'Processing prompt… 100%')
    assert.equal(promptProgressLabel(-0.2), 'Processing prompt… 0%')
    assert.equal(promptProgressLabel(Number.NaN), 'Processing prompt…')
  })
})
