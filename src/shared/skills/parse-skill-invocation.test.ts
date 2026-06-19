import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseSkillInvocation, resolveSkillInvocation } from './parse-skill-invocation.ts'

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

  it('returns null when no leading skill prefix is present', () => {
    assert.equal(parseSkillInvocation('hello /demo-skill'), null)
  })
})

describe('resolveSkillInvocation', () => {
  const known = ['demo-skill', 'ai-writing-signs-report']

  it('prefers a leading skill invocation', () => {
    assert.deepEqual(resolveSkillInvocation('/demo-skill go', known), {
      skillName: 'demo-skill',
      remainder: 'go',
    })
  })

  it('detects an inline skill mention against known skills', () => {
    assert.deepEqual(
      resolveSkillInvocation('Can you check readme for /ai-writing-signs-report', known),
      {
        skillName: 'ai-writing-signs-report',
        remainder: 'Can you check readme for',
      },
    )
  })

  it('ignores inline tokens that are not registered skills', () => {
    assert.equal(
      resolveSkillInvocation('cat /Users/jonathankingston/foo', ['ai-writing-signs-report']),
      null,
    )
  })

  it('returns null when no skill is referenced', () => {
    assert.equal(resolveSkillInvocation('hello world', known), null)
  })
})
