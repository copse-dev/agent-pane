import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearMockScript,
  mockScriptCursorForTests,
  setMockScript,
  takeMockScriptStep,
} from './mock-script.ts'

const TOOLS = [{ name: 'list_dir', description: 'list', parameters: {} }]

describe('mock script', () => {
  it('consumes steps in order across turns', () => {
    setMockScript([
      { when: 'list.*src', tool: { name: 'list_dir', args: { path: 'src' } } },
      { when: 'summarize', text: 'Found the main sources.' },
    ])

    const turn1 = takeMockScriptStep('Please list the src folder', TOOLS)
    assert.equal(turn1?.tool?.name, 'list_dir')
    assert.equal(mockScriptCursorForTests(), 1)

    // Same user turn continuation (agent loop) must not consume the next step.
    assert.equal(takeMockScriptStep('Please list the src folder', TOOLS), null)
    assert.equal(mockScriptCursorForTests(), 1)

    const turn2 = takeMockScriptStep('Can you summarize what you found?', TOOLS)
    assert.equal(turn2?.text, 'Found the main sources.')
    assert.equal(mockScriptCursorForTests(), 2)

    clearMockScript()
    assert.equal(mockScriptCursorForTests(), 0)
  })

  it('does not advance when the pattern or tool does not match', () => {
    setMockScript([
      { when: '^npm install$', tool: { name: 'run_shell', args: { command: 'npm i' } } },
    ])

    assert.equal(takeMockScriptStep('run tests', TOOLS), null)
    assert.equal(mockScriptCursorForTests(), 0)

    assert.equal(
      takeMockScriptStep('npm install', [{ name: 'other', description: '', parameters: {} }]),
      null,
    )
    assert.equal(mockScriptCursorForTests(), 0)

    clearMockScript()
  })
})
