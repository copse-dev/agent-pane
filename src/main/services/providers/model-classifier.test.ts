import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { classifyModelForTask } from './model-classifier.ts'

describe('model-classifier', () => {
  it('routes trivial mechanical edits to the fast tier', () => {
    const rec = classifyModelForTask({ task: 'Rename the variable foo to bar' })
    assert.equal(rec.tier, 'fast')
    assert.equal(rec.model, 'claude-haiku-4-5')
  })

  it('routes design/refactor work to the frontier tier', () => {
    const rec = classifyModelForTask({
      task: 'Refactor the architecture of the agent loop to fix a race condition in concurrent tool calls',
    })
    assert.equal(rec.tier, 'frontier')
    assert.equal(rec.model, 'claude-opus-4-8')
  })

  it('defaults to the balanced tier when there are no strong signals', () => {
    const rec = classifyModelForTask({ task: 'Update the changelog with the new entries listed' })
    assert.equal(rec.tier, 'balanced')
    assert.equal(rec.model, 'claude-sonnet-4-6')
  })

  it('flags when the estimated context exceeds the chosen model window', () => {
    const rec = classifyModelForTask({ task: 'Rename a symbol', contextTokensEstimate: 5_000_000 })
    assert.match(rec.rationale, /exceeds/)
  })

  it('produces a confidence in [0, 1]', () => {
    const rec = classifyModelForTask({ task: 'Plan the migration and redesign the storage layer' })
    assert.ok(rec.confidence >= 0 && rec.confidence <= 1)
  })
})
