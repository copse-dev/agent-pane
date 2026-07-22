import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  parseSkillsBenchProfileId,
  skillsBenchProfile,
  type SkillsBenchSkill,
} from './skillsbench-profiles.mts'

const skills: SkillsBenchSkill[] = [
  { name: 'make-doc', description: 'Create a document safely.', body: '# Make doc\nDo it.' },
]

describe('SkillsBench profiles', () => {
  it('keeps task skill metadata out of the no-skill profile', () => {
    const profile = skillsBenchProfile('skills-none', skills)
    assert.deepEqual(profile.tools, ['run_shell'])
    assert.doesNotMatch(profile.systemPrompt, /make-doc|Create a document|Do it/)
  })

  it('catalogues descriptions without injecting bodies in the product profile', () => {
    const profile = skillsBenchProfile('skills-product', skills)
    assert.deepEqual(profile.tools, ['run_shell', 'read_skill'])
    assert.match(profile.systemPrompt, /make-doc/)
    assert.match(profile.systemPrompt, /Create a document safely/)
    assert.doesNotMatch(profile.systemPrompt, /Do it/)
  })

  it('injects the full untrusted body in the explicit profile', () => {
    const profile = skillsBenchProfile('skills-explicit', skills)
    assert.match(profile.systemPrompt, /<skill_content name="make-doc" trust="untrusted">/)
    assert.match(profile.systemPrompt, /Do it/)
    assert.match(profile.systemPrompt, /do not use the network/i)
  })

  it('accepts versioned inputs and returns a stable content hash', () => {
    assert.equal(parseSkillsBenchProfileId('skills-product@1'), 'skills-product')
    assert.equal(
      skillsBenchProfile('skills-product', skills).contentHash,
      skillsBenchProfile('skills-product', skills).contentHash,
    )
    assert.throws(() => parseSkillsBenchProfileId('main-legacy'))
  })
})
