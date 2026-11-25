import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  agentProfilePromptBlock,
  agentProfilesSchema,
  findAgentProfile,
  newAgentProfileId,
  type AgentProfile,
} from './agent-profiles.ts'

const reviewer: AgentProfile = {
  id: 'reviewer',
  name: 'Reviewer',
  model: 'acp:claude-acp',
  reasoning: 'high',
  instructions: '  Review only.  ',
}

describe('agentProfilesSchema', () => {
  it('accepts saved profiles and refuses duplicate ids or blank names', () => {
    assert.ok(agentProfilesSchema.safeParse([reviewer, { id: 'bug-hunt', name: 'Bugs' }]).success)
    assert.ok(!agentProfilesSchema.safeParse([reviewer, reviewer]).success)
    assert.ok(!agentProfilesSchema.safeParse([{ id: 'x', name: '   ' }]).success)
    assert.ok(!agentProfilesSchema.safeParse([{ id: 'Bad Id', name: 'x' }]).success)
    assert.ok(!agentProfilesSchema.safeParse([{ ...reviewer, reasoning: 'extreme' }]).success)
  })
})

describe('agentProfilePromptBlock', () => {
  it('frames the instructions under the profile name', () => {
    assert.equal(
      agentProfilePromptBlock(reviewer),
      '## Profile instructions: Reviewer\n\nReview only.',
    )
  })

  it('adds nothing for a missing profile or one without instructions', () => {
    assert.equal(agentProfilePromptBlock(undefined), '')
    assert.equal(agentProfilePromptBlock({ id: 'a', name: 'A', instructions: ' \n ' }), '')
  })
})

describe('findAgentProfile', () => {
  it('finds by id and treats a deleted profile as none', () => {
    assert.equal(findAgentProfile([reviewer], 'reviewer'), reviewer)
    assert.equal(findAgentProfile([reviewer], 'gone'), undefined)
    assert.equal(findAgentProfile([reviewer], undefined), undefined)
    assert.equal(findAgentProfile(undefined, 'reviewer'), undefined)
  })
})

describe('newAgentProfileId', () => {
  it('slugs the name and stays unique', () => {
    assert.equal(newAgentProfileId('Bug Hunter!', []), 'bug-hunter')
    assert.equal(
      newAgentProfileId('Reviewer', [reviewer], () => 'abc123'),
      'reviewer-abc123',
    )
    assert.equal(newAgentProfileId('日本', []), 'profile')
    assert.ok(
      agentProfilesSchema.safeParse([{ id: newAgentProfileId('-x-', []), name: 'x' }]).success,
    )
  })
})
