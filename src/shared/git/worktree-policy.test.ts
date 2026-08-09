import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideThreadWorktreePolicy,
  threadWorktreeBranchName,
  type WorktreePolicyInput,
} from './worktree-policy.ts'

const supported: WorktreePolicyInput = {
  choice: 'automatic',
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
      { patch: {}, mode: 'worktree', reason: 'project-always' },
      { patch: { isDirty: true }, mode: 'worktree', reason: 'project-always' },
      // The previous thread leaving the project checkout on its own branch no
      // longer drags the next thread back into the shared checkout.
      {
        patch: { currentBranch: 'copse/previous-thread' },
        mode: 'worktree',
        reason: 'project-always',
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
        isDirty: true,
      }),
      {
        checkoutMode: 'worktree',
        reason: 'explicit-worktree',
        seededFromDirtyProject: true,
      },
    )
  })

  it('only seeds dirty project work when the checkout shares the worktree base', () => {
    const onDefault = decideThreadWorktreePolicy({ ...supported, isDirty: true })
    assert.equal(onDefault.seededFromDirtyProject, true)

    // The edits belong to `feature`, but the worktree is cut from `main`.
    // Restoring them over it would mix two unrelated trees.
    const offDefault = decideThreadWorktreePolicy({
      ...supported,
      isDirty: true,
      currentBranch: 'feature',
    })
    assert.equal(offDefault.checkoutMode, 'worktree')
    assert.equal(offDefault.seededFromDirtyProject, false)
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
