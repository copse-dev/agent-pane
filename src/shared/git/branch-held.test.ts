import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  branchHeldByWorktreeMessage,
  branchHolderPath,
  describeBranchCheckoutFailure,
} from './branch-held.ts'

const SWITCH_FATAL =
  "fatal: 'main' is already used by worktree at '/Users/dev/.copse/worktrees/proj/deb6d7bf'"
const WORKTREE_ADD_FATAL =
  "fatal: 'copse/fix-thing' is already checked out at '/Users/dev/.copse/worktrees/proj/aa11'"

describe('branchHolderPath', () => {
  it('reads the holder out of both git wordings', () => {
    assert.equal(branchHolderPath(SWITCH_FATAL), '/Users/dev/.copse/worktrees/proj/deb6d7bf')
    assert.equal(branchHolderPath(WORKTREE_ADD_FATAL), '/Users/dev/.copse/worktrees/proj/aa11')
  })

  it('leaves unrelated failures alone', () => {
    assert.equal(branchHolderPath("error: pathspec 'nope' did not match any file(s)"), null)
    assert.equal(branchHolderPath(''), null)
  })
})

describe('describeBranchCheckoutFailure', () => {
  it('names the holder and the command that releases the branch', () => {
    const message = describeBranchCheckoutFailure('main', SWITCH_FATAL)
    assert.match(message, /Branch "main" is checked out in another worktree/)
    assert.match(message, /\/Users\/dev\/\.copse\/worktrees\/proj\/deb6d7bf/)
    assert.match(message, /checkout --detach/)
    assert.equal(
      message,
      branchHeldByWorktreeMessage('main', '/Users/dev/.copse/worktrees/proj/deb6d7bf'),
    )
  })

  it('preserves the detail of failures it does not recognize', () => {
    const raw = "error: Your local changes would be overwritten by checkout: 'src/app.ts'"
    assert.equal(describeBranchCheckoutFailure('main', raw), raw)
  })
})
