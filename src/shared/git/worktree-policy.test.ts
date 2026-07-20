import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideThreadWorktreePolicy,
  threadWorktreeBranchName,
  type WorktreePolicyInput,
} from './worktree-policy.ts'

const supported: WorktreePolicyInput = {
  choice: 'automatic',
  projectMode: 'from-default-branch',
  isLocal: true,
  isGitRepository: true,
  currentBranch: 'main',
  defaultBranch: 'main',
  isDirty: false,
  hasSubmodules: false,
}

describe('decideThreadWorktreePolicy', () => {
  it('pins the automatic policy matrix', () => {
    const rows: Array<{
      patch: Partial<WorktreePolicyInput>
      mode: 'shared' | 'worktree'
      reason: string
    }> = [
      { patch: {}, mode: 'worktree', reason: 'default-branch' },
      { patch: { isDirty: true }, mode: 'worktree', reason: 'default-branch' },
      {
        patch: { currentBranch: 'feature' },
        mode: 'shared',
        reason: 'non-default-branch',
      },
      { patch: { isGitRepository: false }, mode: 'shared', reason: 'not-git' },
      {
        patch: { defaultBranch: null },
        mode: 'shared',
        reason: 'default-branch-unresolved',
      },
      { patch: { currentBranch: null }, mode: 'shared', reason: 'detached-head' },
      { patch: { hasSubmodules: true }, mode: 'shared', reason: 'submodules-unsupported' },
      { patch: { isLocal: false }, mode: 'shared', reason: 'not-local' },
      { patch: { projectMode: 'always' }, mode: 'worktree', reason: 'project-always' },
      { patch: { projectMode: 'never' }, mode: 'shared', reason: 'project-disabled' },
    ]

    for (const row of rows) {
      const decision = decideThreadWorktreePolicy({ ...supported, ...row.patch })
      assert.equal(decision.checkoutMode, row.mode)
      assert.equal(decision.reason, row.reason)
    }
  })

  it('honors explicit shared and supported worktree choices', () => {
    assert.deepEqual(decideThreadWorktreePolicy({ ...supported, choice: 'shared' }), {
      checkoutMode: 'shared',
      reason: 'explicit-shared',
      seededFromDirtyProject: false,
    })
    assert.deepEqual(
      decideThreadWorktreePolicy({
        ...supported,
        choice: 'worktree',
        projectMode: 'never',
        currentBranch: 'feature',
        isDirty: true,
      }),
      {
        checkoutMode: 'worktree',
        reason: 'explicit-worktree',
        seededFromDirtyProject: true,
      },
    )
  })

  it('blocks an explicit worktree choice in unsupported repositories', () => {
    const decision = decideThreadWorktreePolicy({
      ...supported,
      choice: 'worktree',
      hasSubmodules: true,
    })
    assert.deepEqual(decision, {
      checkoutMode: 'blocked',
      reason: 'submodules-unsupported',
      seededFromDirtyProject: false,
    })
  })
})

describe('threadWorktreeBranchName', () => {
  it('uses a prompt slug, stable thread suffix, and deterministic collision suffix', () => {
    assert.equal(
      threadWorktreeBranchName('Fix the flicker, please!', 'thread-a1b2'),
      'copse/fix-the-flicker-please-ada1b2',
    )
    assert.equal(
      threadWorktreeBranchName('Fix the flicker, please!', 'thread-a1b2', 1),
      'copse/fix-the-flicker-please-ada1b2-2',
    )
  })

  it('falls back safely when prompt and id have no slug characters', () => {
    assert.equal(threadWorktreeBranchName('✨', '---'), 'copse/thread-thread')
  })
})
