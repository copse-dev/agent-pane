import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  parseSkillsBenchProfileId,
  parseSkillsBenchProfileIds,
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

  it('pins a bare id to v1 and keeps its fixed reasoning cap', () => {
    const bare = skillsBenchProfile('skills-product', skills)
    const explicit = skillsBenchProfile('skills-product@1', skills)
    assert.equal(bare.versionedId, 'skills-product@1')
    assert.equal(bare.reasoningPolicy, 'fixed-cap')
    assert.equal(bare.contentHash, explicit.contentHash)
    // The v1 hash predates checkpointed reasoning and must stay comparable.
    assert.equal(
      bare.contentHash,
      `sha256:${createHash('sha256')
        .update(
          JSON.stringify({
            versionedId: 'skills-product@1',
            tools: ['run_shell', 'read_skill'],
            systemPromptTemplate: skillsBenchProfile('skills-product', [
              {
                name: '__SKILL_NAME__',
                description: '__SKILL_DESCRIPTION__',
                body: '__SKILL_BODY__',
              },
            ]).systemPrompt,
          }),
        )
        .digest('hex')}`,
    )
  })

  it('keeps v2 prompt-identical to v1 while switching the reasoning policy', () => {
    const v1 = skillsBenchProfile('skills-product@1', skills)
    const v2 = skillsBenchProfile('skills-product@2', skills)
    assert.equal(v2.systemPrompt, v1.systemPrompt)
    assert.deepEqual(v2.tools, v1.tools)
    assert.equal(v2.reasoningPolicy, 'circle-gated-2k-checkpoints-v1')
    assert.notEqual(v2.contentHash, v1.contentHash)
  })

  it('parses paired arms and rejects duplicates', () => {
    assert.deepEqual(parseSkillsBenchProfileIds('skills-product@1,skills-product@2'), [
      'skills-product@1',
      'skills-product@2',
    ])
    assert.throws(() => parseSkillsBenchProfileIds('skills-product,skills-product@1'), /duplicates/)
    assert.throws(() => parseSkillsBenchProfileIds('skills-product,'), /empty items/)
    assert.throws(() => parseSkillsBenchProfileIds('skills-product@3'), /must be one of/)
  })
})
