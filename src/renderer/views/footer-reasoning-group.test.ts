import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  REASONING_GROUP_ID,
  reasoningLevelFromGroupValue,
  reasoningValueGroup,
} from './footer-reasoning-group.ts'

function values(model: string, level?: 'max' | 'xhigh'): string[] {
  return (reasoningValueGroup(model, level)?.choices ?? []).map((choice) => choice.value)
}

describe('footer reasoning group', () => {
  it('offers the levels the selected model accepts, after the default', () => {
    assert.deepEqual(values('claude-opus-5'), ['', 'off', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('is absent for a model with no reasoning control', () => {
    assert.equal(reasoningValueGroup('gpt-4o', undefined), null)
  })

  it('is absent for a selection that owns its own settings', () => {
    assert.equal(reasoningValueGroup('acp:claude-code#opus', undefined), null)
  })

  it('shows the thread’s current level as the group value', () => {
    const group = reasoningValueGroup('claude-opus-5', 'max')
    assert.ok(group)
    assert.equal(group.id, REASONING_GROUP_ID)
    assert.equal(group.currentValue, 'max')
  })

  it('reads as the model default when the thread has no level', () => {
    assert.equal(reasoningValueGroup('claude-opus-5', undefined)?.currentValue, '')
  })

  it('falls back to the default when the model no longer offers the saved level', () => {
    // Sonnet 4.6's ladder stops short of xhigh.
    assert.equal(reasoningValueGroup('claude-sonnet-4-6', 'xhigh')?.currentValue, '')
  })

  it('follows a model change back to one that reasons', () => {
    assert.deepEqual(values('gpt-5.6-sol'), ['', 'minimal', 'low', 'medium', 'high'])
  })

  it('reports a picked level, and reports the default as undefined', () => {
    assert.equal(reasoningLevelFromGroupValue('xhigh'), 'xhigh')
    assert.equal(reasoningLevelFromGroupValue(''), undefined)
  })
})
