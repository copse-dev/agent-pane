import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseSkillInvocation } from './parse-skill-invocation.ts'

describe('parseSkillInvocation', () => {
  it('parses a skill prefix with remainder text', () => {
    assert.deepEqual(parseSkillInvocation('/demo-skill deploy my app'), {
      skillName: 'demo-skill',
      remainder: 'deploy my app',
    })
  })

  it('parses a skill prefix without remainder', () => {
    assert.deepEqual(parseSkillInvocation('/demo-skill'), {
      skillName: 'demo-skill',
      remainder: '',
    })
  })

  it('returns null when no skill prefix is present', () => {
    assert.equal(parseSkillInvocation('hello /demo-skill'), null)
  })
})
