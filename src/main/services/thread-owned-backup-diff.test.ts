import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  runWithThreadExecutionContext,
  type ThreadExecutionContext,
} from './thread-execution-context.ts'
import {
  clearSessionBackupsForTest,
  getSessionBackup,
  setSessionBackupForTest,
} from './worktree-backup.ts'
import {
  clearDiffQueueForTest,
  getStagedDiffEntry,
  listStagedDiffEntries,
  stageDiff,
} from './diff-queue.ts'

function context(projectId: string, threadId: string, root: string): ThreadExecutionContext {
  return {
    projectId,
    threadId,
    projectRoot: root,
    root,
    checkoutMode: 'shared',
    branch: null,
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return {
    promise,
    resolve: (): void => {
      if (!resolve) throw new Error('deferred resolver missing')
      resolve()
    },
  }
}

describe('thread-owned backup and diff state', () => {
  afterEach(() => {
    clearDiffQueueForTest()
    clearSessionBackupsForTest()
  })

  it('keeps the same relative path attributed across deterministic interleaved runs', async () => {
    const firstContext = context('project-a', 'thread-a', '/workspace/a')
    const secondContext = context('project-b', 'thread-b', '/workspace/b')
    const firstStaged = deferred()
    const releaseFirst = deferred()

    const first = runWithThreadExecutionContext(firstContext, async () => {
      setSessionBackupForTest({ ref: 'refs/backups/a', createdAt: 1, paths: ['same.txt'] })
      await stageDiff('same.txt', 'before-a', 'after-a', 'plaintext')
      firstStaged.resolve()
      await releaseFirst.promise
      return {
        backup: getSessionBackup(),
        entry: getStagedDiffEntry('same.txt'),
        count: listStagedDiffEntries().length,
      }
    })

    await firstStaged.promise

    const second = await runWithThreadExecutionContext(secondContext, async () => {
      setSessionBackupForTest({ ref: 'refs/backups/b', createdAt: 2, paths: ['same.txt'] })
      await stageDiff('same.txt', 'before-b', 'after-b', 'plaintext')
      return {
        backup: getSessionBackup(),
        entry: getStagedDiffEntry('same.txt'),
        count: listStagedDiffEntries().length,
      }
    })

    releaseFirst.resolve()
    const firstResult = await first

    assert.equal(firstResult.backup?.ref, 'refs/backups/a')
    assert.equal(firstResult.entry?.after, 'after-a')
    assert.equal(firstResult.count, 1)
    assert.equal(second.backup?.ref, 'refs/backups/b')
    assert.equal(second.entry?.after, 'after-b')
    assert.equal(second.count, 1)
  })

  it('rejects run-scoped state access without an execution context', () => {
    assert.throws(() => getSessionBackup(), /No thread execution context/)
    assert.throws(
      () => stageDiff('same.txt', '', 'after', 'plaintext'),
      /No thread execution context/,
    )
  })
})
