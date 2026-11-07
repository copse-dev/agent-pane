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

  it('names no project or repository outside an agent run, whatever the window shows', async () => {
    const roots: Array<string | null> = []
    storageSet('activeProjectId', 'project-being-viewed')
    try {
      assert.equal(resolveRemoteAgentProjectId(), null)
      const repository = await resolveRemoteAgentRepository({
        getGithubRepoSlug: (root) => {
          roots.push(root)
          return Promise.resolve(root ? 'acme/viewed' : null)
        },
      })
      assert.equal(repository, null)
    } finally {
      storageSet('activeProjectId', null)
    }
    assert.deepEqual(roots, [null])
  })

  it('resolves two concurrent runs in different projects to their own project and checkout', async () => {
    storageSet('activeProjectId', 'project-being-viewed')
    const run = (
      projectId: string,
    ): Promise<{ projectId: string | null; repository: string | null }> =>
      runWithThreadExecutionContext(
        {
          projectId,
          threadId: `thread-${projectId}`,
          projectRoot: `/${projectId}`,
          root: `/${projectId}-worktree`,
          checkoutMode: 'worktree',
          branch: null,
        },
        async () => {
          // Yield so the two runs interleave before either resolves.
          await new Promise((resolve) => setImmediate(resolve))
          return {
            projectId: resolveRemoteAgentProjectId(),
            repository: await resolveRemoteAgentRepository({
              getGithubRepoSlug: (root) => Promise.resolve(root ? `acme${root}` : null),
            }),
          }
        },
      )
    try {
      const [a, b] = await Promise.all([run('project-a'), run('project-b')])
      assert.deepEqual(a, {
        projectId: 'project-a',
        repository: 'https://github.com/acme/project-a-worktree',
      })
      assert.deepEqual(b, {
        projectId: 'project-b',
        repository: 'https://github.com/acme/project-b-worktree',
      })
    } finally {
      storageSet('activeProjectId', null)
    }
  })
})
