import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertMockScenarioComplete,
  clearMockScenarios,
  mockScenarioStatus,
  mockScenarioTitle,
  parseMockScenario,
  setMockScenario,
} from './mock-script.ts'

afterEach(() => {
  clearMockScenarios()
})

describe('mock scenarios', () => {
  it('validates external data and preserves only the typed scenario shape', () => {
    const scenario = parseMockScenario({
      title: 'Inspect source files',
      turns: [
        {
          user: 'Inspect src',
          responses: [
            { toolCalls: [{ name: 'list_dir', args: { path: 'src' } }] },
            {
              expectToolResults: [{ name: 'list_dir', includes: 'index.ts' }],
              text: 'The source directory contains the application entry point.',
            },
          ],
        },
      ],
    })
    assert.equal(
      scenario.turns[0]?.responses[1]?.text,
      'The source directory contains the application entry point.',
    )
    assert.throws(
      () =>
        parseMockScenario({
          title: 'Broken',
          turns: [{ user: 'x', responses: [{ text: 'ok' }], extra: true }],
        }),
      /unknown property/,
    )
    assert.throws(
      () =>
        parseMockScenario({
          title: 'Broken',
          turns: [{ user: 'x', responses: [{ toolCalls: [] }] }],
        }),
      /non-empty array/,
    )
  })

  it('rejects malformed progress, latency, continuation, and machine matcher controls', () => {
    for (const response of [
      { promptProgress: NaN },
      { promptProgress: 1.1 },
      { promptProgress: -0.1 },
      { delayMs: -1 },
      { delayMs: 30_001 },
      { continueTurn: 'yes' },
      { continueTurn: true },
    ]) {
      assert.throws(
        () =>
          parseMockScenario({
            title: 'Invalid control',
            turns: [{ user: 'Inspect', responses: [{ text: 'Complete', ...response }] }],
          }),
        /Invalid mock scenario/,
      )
    }
    for (const user of [{ includes: '' }, { includes: 'Background', extra: true }]) {
      assert.throws(
        () =>
          parseMockScenario({
            title: 'Invalid matcher',
            turns: [{ user, responses: [{ text: 'Complete' }] }],
          }),
        /Invalid mock scenario/,
      )
    }
  })

  it('tracks scoped registrations, titles, and completed replacement handles', () => {
    const first = {
      title: 'First title',
      turns: [{ user: 'First prompt', responses: [{ text: 'First reply' }] }],
    }
    setMockScenario('first', first, 'thread-a')
    assert.equal(mockScenarioTitle('First prompt'), 'First title')
    assert.equal(mockScenarioTitle('unknown prompt'), null)
    assert.throws(() => {
      setMockScenario(
        'second',
        {
          title: 'Second',
          turns: [{ user: 'Second prompt', responses: [{ text: 'Second reply' }] }],
        },
        'thread-a',
      )
    }, /still running/)
    assert.deepEqual(mockScenarioStatus('first').errors, [])
  })

  it('reports incomplete and failed scenario assertions clearly', () => {
    setMockScenario(
      'incomplete',
      { title: 'Incomplete', turns: [{ user: 'Continue', responses: [{ text: 'Waiting' }] }] },
      'thread-a',
    )
    assert.throws(() => {
      assertMockScenarioComplete('incomplete')
    }, /incomplete/)
  })
})
