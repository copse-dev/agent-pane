import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRemoteAgentProjectId, resolveRemoteAgentRepository } from './remote-agent-shared.ts'
import { runWithThreadExecutionContext } from '../thread-execution-context.ts'
import { storageSet } from '../storage/storage.ts'

describe('remote agent execution ownership', () => {
  it('resolves the repository from the thread execution root, not the viewed project', async () => {
    const roots: Array<string | null> = []
    storageSet('activeProjectId', 'project-being-viewed')

    try {
      await runWithThreadExecutionContext(
        {
          projectId: 'project-owning-run',
          threadId: 'thread-background',
          projectRoot: '/project-owning-run',
          root: '/project-owning-run-worktree',
          checkoutMode: 'worktree',
          branch: 'bugfix',
        },
        () => {
          assert.equal(resolveRemoteAgentProjectId(), 'project-owning-run')
          return resolveRemoteAgentRepository({
            getGithubRepoSlug: (root) => {
              roots.push(root)
              return Promise.resolve('acme/background-project')
            },
          })
        },
      )
    } finally {
      storageSet('activeProjectId', null)
    }

    assert.deepEqual(roots, ['/project-owning-run-worktree'])
  })

  it('falls back to the viewed project outside an agent run', () => {
    storageSet('activeProjectId', 'project-being-viewed')
    try {
      assert.equal(resolveRemoteAgentProjectId(), 'project-being-viewed')
    } finally {
      storageSet('activeProjectId', null)
    }
  })
})
