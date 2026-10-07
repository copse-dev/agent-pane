import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recordSuccessfulCommit } from './commit-production.ts'
import type { ThreadExecutionContext } from '../thread-execution-context-store.ts'
import type { CommitProduction } from '@shared/git/thread-pr-relations.ts'
const context: ThreadExecutionContext = {
  projectId: 'project',
  threadId: 'thread',
  root: '/repo',
  projectRoot: '/repo',
  branch: 'main',
  checkoutMode: 'shared',
}

test('records the reported commit, even if another thread has advanced shared HEAD', async () => {
  const calls: string[][] = []
  const events: CommitProduction[] = []
  const sha = 'a'.repeat(40)
  const ok = await recordSuccessfulCommit(
    '[main aaaaaaa] Requested commit\n 1 file changed',
    context,
    {
      repository: 'github.com/acme/widgets',
      readGit: (args) => {
        calls.push(args)
        return Promise.resolve({ code: 0, stdout: sha })
      },
      record: async (projectId, threadId, event) => {
        assert.equal(projectId, 'project')
        assert.equal(threadId, 'thread')
        events.push(event)
      },
    },
  )
  assert.equal(ok, true)
  assert.deepEqual(calls, [['rev-parse', '--verify', 'aaaaaaa^{commit}']])
  assert.equal(events[0]?.sha, sha)
  assert.equal(events[0].source, 'git-commit')
})

test('quiet, ambiguous, mismatched, or failed resolution stays unknown', async () => {
  let recorded = false
  for (const output of ['', '[main aaaaaaa] Hook text\n[main bbbbbbb] Real commit']) {
    assert.equal(
      await recordSuccessfulCommit(output, context, {
        repository: 'github.com/acme/widgets',
        readGit: async () => ({ code: 0, stdout: 'a'.repeat(40) }),
        record: async () => {
          recorded = true
        },
      }),
      false,
    )
  }
  for (const result of [
    { code: 1, stdout: '' },
    { code: 0, stdout: 'b'.repeat(40) },
  ]) {
    assert.equal(
      await recordSuccessfulCommit('[main aaaaaaa] Commit', context, {
        repository: 'github.com/acme/widgets',
        readGit: async () => result,
        record: async () => {
          recorded = true
        },
      }),
      false,
    )
  }
  assert.equal(recorded, false)
})
