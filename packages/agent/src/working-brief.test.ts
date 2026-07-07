import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LLMMessage } from '@copse/llm/wire-types.ts'
import {
  extractParentGoal,
  nextWorkingBrief,
  resolveParentGoal,
  workingBriefFromUserContent,
  WORKING_BRIEF_MAX_LEN,
} from './working-brief.ts'

describe('workingBriefFromUserContent', () => {
  it('extracts trimmed string content', () => {
    assert.equal(workingBriefFromUserContent('  refactor auth  '), 'refactor auth')
  })

  it('joins text blocks and ignores images', () => {
    const brief = workingBriefFromUserContent([
      { type: 'image', dataUrl: 'data:image/png;base64,abc' },
      { type: 'text', text: 'Review ' },
      { type: 'text', text: 'the module' },
    ])
    assert.equal(brief, 'Review \nthe module')
  })

  it('returns null for empty content', () => {
    assert.equal(workingBriefFromUserContent('   '), null)
  })
})

describe('resolveParentGoal', () => {
  const prior: LLMMessage[] = [
    { role: 'user', content: 'original goal' },
    { role: 'assistant', content: 'ok' },
  ]

  it('prefers persisted workingBrief over last user message', () => {
    assert.equal(
      resolveParentGoal('refactor authentication', prior, 'check tests now'),
      'refactor authentication',
    )
  })

  it('falls back to extractParentGoal when workingBrief is absent', () => {
    assert.equal(resolveParentGoal(undefined, prior, 'check tests now'), 'original goal')
  })

  it('uses current prompt when history has no user string message', () => {
    const messages: LLMMessage[] = [{ role: 'assistant', content: 'hi' }]
    assert.equal(resolveParentGoal(undefined, messages, 'first turn'), 'first turn')
  })
})

describe('nextWorkingBrief', () => {
  it('sets brief on first user message', () => {
    assert.equal(nextWorkingBrief(undefined, 'implement issue 35'), 'implement issue 35')
  })

  it('keeps existing brief on follow-up messages', () => {
    assert.equal(nextWorkingBrief('implement issue 35', 'also run tests'), 'implement issue 35')
  })
})

describe('extractParentGoal', () => {
  it('truncates long content', () => {
    const long = 'x'.repeat(WORKING_BRIEF_MAX_LEN + 100)
    assert.equal(extractParentGoal([], long).length, WORKING_BRIEF_MAX_LEN)
  })
})
