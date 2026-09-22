import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  deleteThreadResourcesAndStore,
  type ThreadDeletionDependencies,
  type ThreadDeletionRuntime,
} from './thread-deletion.ts'

function harness(options: { failAt?: string } = {}): {
  calls: string[]
  runtime: ThreadDeletionRuntime
  dependencies: ThreadDeletionDependencies
} {
  const calls: string[] = []
  const step = (name: string): void => {
    calls.push(name)
    if (options.failAt === name) throw new Error(`failed at ${name}`)
  }
  return {
    calls,
    runtime: {
      stopAndWaitForAgent: async (projectId, threadId): Promise<void> => {
        step(`stop:${projectId}:${threadId}`)
      },
      resumeAfterFailedDeletion: (projectId, threadId): void => {
        step(`resume:${projectId}:${threadId}`)
      },
      forgetAgentHistory: (projectId, threadId): void => {
        step(`forget:${projectId}:${threadId}`)
      },
    },
    dependencies: {
      cancelApprovals: (threadId): void => {
        step(`approvals:${threadId}`)
      },
      disposeAcp: async (threadId): Promise<void> => {
        step(`acp:${threadId}`)
      },
      destroyTerminals: async (threadId): Promise<void> => {
        step(`terminals:${threadId}`)
      },
      stopBackgroundProcesses: async ({ projectId, threadId }): Promise<void> => {
        step(`processes:${projectId}:${threadId}`)
      },
      clearRemoteSession: (threadId): void => {
        step(`remote:${threadId}`)
      },
      clearRedaction: (threadId): void => {
        step(`redaction:${threadId}`)
      },
      clearModels: (threadId): void => {
        step(`models:${threadId}`)
      },
      clearReadRoots: (threadId): void => {
        step(`read-roots:${threadId}`)
      },
      clearToolCache: (threadId): void => {
        step(`tool-cache:${threadId}`)
      },
      clearDeniedOperations: (threadId): void => {
        step(`denials:${threadId}`)
      },
      deleteStore: async (projectId, threadId): Promise<void> => {
        step(`delete:${projectId}:${threadId}`)
      },
    },
  }
}

describe('deleteThreadResourcesAndStore', () => {
  it('stops live work and clears thread-owned state before deleting the store', async () => {
    const { calls, runtime, dependencies } = harness()

    await deleteThreadResourcesAndStore('project-a', 'thread-a', runtime, dependencies)

    assert.deepEqual(calls, [
      'approvals:thread-a',
      'stop:project-a:thread-a',
      'acp:thread-a',
      'terminals:thread-a',
      'processes:project-a:thread-a',
      'remote:thread-a',
      'redaction:thread-a',
      'models:thread-a',
      'read-roots:thread-a',
      'tool-cache:thread-a',
      'denials:thread-a',
      'forget:project-a:thread-a',
      'delete:project-a:thread-a',
    ])
  })

  it('keeps the durable store when resource cleanup fails', async () => {
    const { calls, runtime, dependencies } = harness({ failAt: 'terminals:thread-a' })

    await assert.rejects(
      deleteThreadResourcesAndStore('project-a', 'thread-a', runtime, dependencies),
      /failed at terminals:thread-a/,
    )

    assert.deepEqual(calls, [
      'approvals:thread-a',
      'stop:project-a:thread-a',
      'acp:thread-a',
      'terminals:thread-a',
      'resume:project-a:thread-a',
    ])
  })

  it('keeps the dispatch fence if durable deletion itself fails', async () => {
    const { calls, runtime, dependencies } = harness({ failAt: 'delete:project-a:thread-a' })

    await assert.rejects(
      deleteThreadResourcesAndStore('project-a', 'thread-a', runtime, dependencies),
      /failed at delete:project-a:thread-a/,
    )

    assert.equal(calls.at(-1), 'delete:project-a:thread-a')
    assert.equal(
      calls.some((call) => call.startsWith('resume:')),
      false,
    )
  })
})
