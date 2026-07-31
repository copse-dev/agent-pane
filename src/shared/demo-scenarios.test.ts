import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEMO_SCENARIOS } from './demo-scenarios.ts'

describe('demo scenarios', () => {
  it('enables developerMode for the footer-compact overflow geometry demo', () => {
    const scenario = DEMO_SCENARIOS.find((entry) => entry.id === 'footer-compact')
    assert.ok(scenario)
    assert.equal(scenario.settings['developerMode'], true)
  })
})
