import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildSkillUserText } from './build-skill-user-content.ts'

describe('buildSkillUserText', () => {
  it('passes through non-empty remainder', () => {
    assert.equal(
      buildSkillUserText('demo-skill', 'validate skills support', false),
      'validate skills support',
    )
  })

  it('uses attachment prompt when remainder is empty and files are attached', () => {
    assert.match(
      buildSkillUserText('ai-writing-signs-report', '', true),
      /invoked \/ai-writing-signs-report.*attached file\(s\)/,
    )
  })

  it('uses default prompt when remainder is empty and no attachments', () => {
    assert.equal(
      buildSkillUserText('demo-skill', '', false),
      'The user invoked /demo-skill. Follow the skill instructions.',
    )
  })
})
