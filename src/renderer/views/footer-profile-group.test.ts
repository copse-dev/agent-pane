import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROFILE_GROUP_ID,
  profileIdFromGroupValue,
  profileValueGroup,
} from './footer-profile-group.ts'

describe('profileValueGroup', () => {
  const profiles = [
    { id: 'reviewer', name: 'Reviewer', instructions: 'Review the diff\n  for correctness.' },
    { id: 'builder', name: 'Builder' },
  ]

  it('offers None plus every profile, marking the chat’s', () => {
    const group = profileValueGroup(profiles, 'builder')
    assert.ok(group)
    assert.equal(group.id, PROFILE_GROUP_ID)
    assert.equal(group.currentValue, 'builder')
    assert.deepEqual(
      group.choices.map((choice) => choice.label),
      ['None', 'Reviewer', 'Builder'],
    )
    assert.equal(group.choices[1]?.description, 'Review the diff for correctness.')
  })

  it('has no row without profiles, and reads a deleted profile as none', () => {
    assert.equal(profileValueGroup([], undefined), null)
    assert.equal(profileValueGroup(profiles, 'deleted')?.currentValue, '')
  })

  it('maps None back to no profile', () => {
    assert.equal(profileIdFromGroupValue(''), undefined)
    assert.equal(profileIdFromGroupValue('reviewer'), 'reviewer')
  })
})
