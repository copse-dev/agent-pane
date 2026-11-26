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

describe('working brief cap and surrogate pairs', () => {
  it('never ends the brief on half of a surrogate pair', () => {
    // The cap lands between the two code units of U+1F600. The lone surrogate
    // reached subagent prompts through the parent goal and failed the request.
    const prompt = `${'a'.repeat(WORKING_BRIEF_MAX_LEN - 1)}\u{1F600} tail`
    const expected = 'a'.repeat(WORKING_BRIEF_MAX_LEN - 1)
    assert.equal(workingBriefFromUserContent(prompt), expected)
    assert.equal(workingBriefFromUserContent([{ type: 'text', text: prompt }]), expected)
    assert.equal(extractParentGoal([], prompt), expected)
    assert.equal(extractParentGoal([{ role: 'user', content: prompt }], 'unused'), expected)
  })
})
