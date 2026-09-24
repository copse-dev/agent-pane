import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertMockScenarioComplete,
  clearMockScenarios,
  mockScenarioStatus,
  setMockScenario,
} from '@copse/llm/mock-script.ts'
import { buildProvider } from './provider-selection.ts'
import { resolveSmallTasksProvider } from './small-tasks-provider.ts'
import { suggestThreadTitle } from '../title-generator.ts'

let previousMock: string | undefined

beforeEach(() => {
  previousMock = process.env['COPSE_PANEL_MOCK_LLM']
  process.env['COPSE_PANEL_MOCK_LLM'] = '1'
})

afterEach(() => {
  clearMockScenarios()
  if (previousMock === undefined) delete process.env['COPSE_PANEL_MOCK_LLM']
  else process.env['COPSE_PANEL_MOCK_LLM'] = previousMock
})

describe('mock conversation routing', () => {
  it('uses the thread scope across provider instances without consuming replies for titles', async () => {
    setMockScenario(
      'source-review',
      {
        title: 'Review Project Sources',
        turns: [
          {
            user: 'Review the project sources.',
            responses: [{ text: 'The entry point is main.ts.' }],
          },
          {
            user: 'Where is the renderer?',
            responses: [{ text: 'The renderer lives in src/renderer.' }],
          },
        ],
      },
      'thread-a',
    )

    assert.equal(await suggestThreadTitle('Review the project sources.'), 'Review Project Sources')
    assert.equal(await resolveSmallTasksProvider(), null)
    assert.equal(mockScenarioStatus('source-review').turn, 0)

    const first = await buildProvider('lmstudio:unused', 'thread-a')
    const initial = await Array.fromAsync(
      first.stream([{ role: 'user', content: 'Review the project sources.' }], []),
    )
    assert.equal(
      initial
        .filter((chunk) => chunk.type === 'text')
        .map((chunk) => chunk.text)
        .join(''),
      'The entry point is main.ts.',
    )

    const second = await buildProvider('lmstudio:unused', 'thread-a')
    const followup = await Array.fromAsync(
      second.stream(
        [
          { role: 'user', content: 'Review the project sources.' },
          { role: 'assistant', content: 'The entry point is main.ts.' },
          { role: 'user', content: 'Where is the renderer?' },
        ],
        [],
      ),
    )
    assert.equal(
      followup
        .filter((chunk) => chunk.type === 'text')
        .map((chunk) => chunk.text)
        .join(''),
      'The renderer lives in src/renderer.',
    )
    assertMockScenarioComplete('source-review')
  })

  it('lets unscripted titles use the existing heuristic fallback', async () => {
    assert.equal(await suggestThreadTitle('Describe the project layout.'), null)
  })
})
