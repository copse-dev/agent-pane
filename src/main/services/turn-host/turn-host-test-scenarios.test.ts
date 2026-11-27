import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { clearMockScenarios, mockScenarioStatus } from '@copse/llm/mock-script.ts'
import type { TestScenarioOp, TestScenarioStatus } from './turn-host-protocol.ts'
import {
  runTestScenarioEverywhere,
  runTestScenarioOp,
  setTestScenarioForwarder,
} from './turn-host-test-scenarios.ts'

const scenario = { title: 'S', turns: [{ user: 'Hi', responses: [{ text: 'Hello' }] }] }

function status(overrides: Partial<TestScenarioStatus> = {}): TestScenarioStatus {
  return {
    complete: false,
    turn: 0,
    response: 0,
    waitingFor: null,
    cancelledTurns: 0,
    errors: [],
    ...overrides,
  }
}

afterEach(() => {
  setTestScenarioForwarder(null)
  clearMockScenarios()
})

describe('test scenarios for host turns', () => {
  it('sets a scenario here and in the host', async () => {
    const sent: TestScenarioOp[] = []
    setTestScenarioForwarder((op) => {
      sent.push(op)
      return Promise.resolve({ status: status() })
    })
    await runTestScenarioEverywhere({ kind: 'set', scenarioId: 's1', scenario })
    assert.equal(mockScenarioStatus('s1').complete, false)
    assert.deepEqual(sent, [{ kind: 'set', scenarioId: 's1', scenario }])
  })

  it('fails a set the host refused, so no turn claims from a copy the test cannot see', async () => {
    setTestScenarioForwarder(() => Promise.resolve({ error: 'still running' }))
    await assert.rejects(
      runTestScenarioEverywhere({ kind: 'set', scenarioId: 's1', scenario }),
      /still running/,
    )
  })

  it('reads a scenario from the host after a relaunch, when this app never set it', async () => {
    const held = status({ waitingFor: 'hold' })
    setTestScenarioForwarder(() => Promise.resolve({ status: held }))
    assert.deepEqual(await runTestScenarioEverywhere({ kind: 'status', scenarioId: 'gone' }), held)
    setTestScenarioForwarder(null)
    await assert.rejects(runTestScenarioEverywhere({ kind: 'status', scenarioId: 'gone' }))
  })

  it('reports the copy that ran further', async () => {
    runTestScenarioOp({ kind: 'set', scenarioId: 's1', scenario })
    const held = status({ waitingFor: 'hold' })
    setTestScenarioForwarder(() => Promise.resolve({ status: held }))
    assert.deepEqual(await runTestScenarioEverywhere({ kind: 'status', scenarioId: 's1' }), held)
    setTestScenarioForwarder(() => Promise.resolve({ status: status() }))
    assert.equal(
      (await runTestScenarioEverywhere({ kind: 'status', scenarioId: 's1' }))?.waitingFor,
      null,
    )
  })
})
