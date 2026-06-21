import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  threadGitBranchMismatch,
  threadGitBranchMismatchMessage,
} from '@shared/git/thread-branch.ts'

describe('threadGitBranchMismatch', () => {
  it('is false when the thread is unbound', () => {
    assert.equal(threadGitBranchMismatch(undefined, 'main'), false)
  })

  it('is false when branches match', () => {
    assert.equal(threadGitBranchMismatch('feature', 'feature'), false)
  })

  it('is true when branches differ', () => {
    assert.equal(threadGitBranchMismatch('feature', 'main'), true)
  })
})

describe('threadGitBranchMismatchMessage', () => {
  it('names the thread branch', () => {
    assert.equal(
      threadGitBranchMismatchMessage('feature'),
      'This thread is for branch "feature". Check out that branch to continue.',
    )
  })
})
