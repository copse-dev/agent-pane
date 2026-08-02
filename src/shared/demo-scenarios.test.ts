import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEMO_SCENARIOS } from './demo-scenarios.ts'

describe('demo scenarios', () => {
  it('enables developerMode for the footer-compact overflow geometry demo', () => {
    const scenario = DEMO_SCENARIOS.find((entry) => entry.id === 'footer-compact')
    assert.ok(scenario)
    assert.equal(scenario.settings['developerMode'], true)
  })

  it('starts the landing walkthrough on an empty thread so the prompt can be typed in', () => {
    const scenario = DEMO_SCENARIOS.find((entry) => entry.id === 'landing')
    assert.ok(scenario)
    assert.ok(scenario.trace, 'the walkthrough needs a trace to replay')
    assert.notEqual(scenario.trace.prompt.trim(), '')
    assert.deepEqual(
      scenario.threads.map((thread) => thread.messages.length),
      [0],
    )
  })

  it('ends every trace on a done chunk, so the composer never stays stuck on Stop', () => {
    for (const scenario of DEMO_SCENARIOS) {
      if (!scenario.trace) continue
      assert.equal(
        scenario.trace.steps.at(-1)?.chunk.type,
        'done',
        `${scenario.id} trace must end with a done chunk`,
      )
    }
  })
})
