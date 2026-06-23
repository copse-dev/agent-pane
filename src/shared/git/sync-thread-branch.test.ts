import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import { syncThreadGitBranchIfChanged, threadGitBranchNeedsSync } from './sync-thread-branch.ts'

function thread(id: string, branch?: string): Thread {
  const value: Thread = {
    id,
    title: 'Test',
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
  if (branch) value.gitBranch = branch
  return value
}

describe('threadGitBranchNeedsSync', () => {
  it('returns true when checkout differs from the bound branch', () => {
    assert.equal(threadGitBranchNeedsSync('main', 'feature/acp'), true)
  })

  it('returns false when branches match or checkout is unknown', () => {
    assert.equal(threadGitBranchNeedsSync('main', 'main'), false)
    assert.equal(threadGitBranchNeedsSync('main', null), false)
  })

  it('returns true when the thread branch is unset', () => {
    assert.equal(threadGitBranchNeedsSync(undefined, 'main'), true)
  })
})

describe('syncThreadGitBranchIfChanged', () => {
  it('updates the thread branch when checkout changed', () => {
    const store = createStore({ threads: [thread('t1', 'main')] })
    const changed = syncThreadGitBranchIfChanged(store, 't1', 'feature/acp')
    assert.equal(changed, true)
    assert.equal(store.getState().threads[0]!.gitBranch, 'feature/acp')
  })

  it('binds an unset thread branch to the current checkout', () => {
    const store = createStore({ threads: [thread('t1')] })
    const changed = syncThreadGitBranchIfChanged(store, 't1', 'feature/acp')
    assert.equal(changed, true)
    assert.equal(store.getState().threads[0]!.gitBranch, 'feature/acp')
  })

  it('is a no-op when checkout already matches', () => {
    const store = createStore({ threads: [thread('t1', 'main')] })
    const changed = syncThreadGitBranchIfChanged(store, 't1', 'main')
    assert.equal(changed, false)
    assert.equal(store.getState().threads[0]!.gitBranch, 'main')
  })
})
