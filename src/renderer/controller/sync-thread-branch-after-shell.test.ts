import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createStore } from '@shared/store/store.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { syncThreadGitBranchAfterShell } from './sync-thread-branch-after-shell.ts'

describe('branch synchronization after an unavailable checkout', () => {
  it('preserves the recorded branch after a known checkout refusal', async () => {
    const store = createStore({
      activeProjectId: 'project',
      threads: [
        {
          id: 'thread',
          title: 'Recover checkout',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          gitBranch: 'copse/thread',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })
    const base = createFakeApi()
    const api = {
      ...base,
      git: {
        ...base.git,
        branchStatus: async (): Promise<never> => {
          throw new Error(
            "Error invoking remote method 'git:branch-status': ThreadWorktreeOnBaseBranchError: on main",
          )
        },
      },
    }
    await syncThreadGitBranchAfterShell(store, api, 'thread')
    assert.equal(store.getState().threads[0]?.gitBranch, 'copse/thread')
  })

  it('does not swallow genuine branch-status failures', async () => {
    const store = createStore({ activeProjectId: 'project' })
    const base = createFakeApi()
    const api = {
      ...base,
      git: {
        ...base.git,
        branchStatus: async (): Promise<never> => {
          throw new Error('IPC regression')
        },
      },
    }
    await assert.rejects(syncThreadGitBranchAfterShell(store, api, 'thread'), /IPC regression/)
  })
})
