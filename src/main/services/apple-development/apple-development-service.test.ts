import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type {
  SupervisedTaskArchive,
  SupervisedTaskAuditEvent,
  SupervisedTaskMeta,
} from '@shared/supervisor/task-schema.ts'
import { storageDelete } from '../storage/storage.ts'
import type { LoadedSupervisedTasks, SupervisedTaskStore } from '../supervisor/task-store.ts'
import { TaskSupervisor } from '../supervisor/task-supervisor.ts'
import type { ThreadExecutionContext } from '../thread-execution-context.ts'
import { InstalledXcodeDriver, type AppleDriverDiscovery } from './apple-driver.ts'
import { AppleDevelopmentService } from './apple-development-service.ts'

const STORE_KEY = 'plugin.copse.apple-development.state'

class EmptyTaskStore implements SupervisedTaskStore {
  loadAll(): Promise<LoadedSupervisedTasks> {
    return Promise.resolve({ tasks: [], diagnostics: [] })
  }

  loadProject(): Promise<LoadedSupervisedTasks> {
    return Promise.resolve({ tasks: [], diagnostics: [] })
  }

  get(): Promise<SupervisedTaskMeta | null> {
    return Promise.resolve(null)
  }

  saveTransition(_meta: SupervisedTaskMeta, _audit: SupervisedTaskAuditEvent): Promise<void> {
    return Promise.resolve()
  }

  compactTerminalTasks(): Promise<number> {
    return Promise.resolve(0)
  }

  loadTaskArchive(): Promise<SupervisedTaskArchive[]> {
    return Promise.resolve([])
  }
}

describe('AppleDevelopmentService enrollment', () => {
  beforeEach(() => {
    storageDelete(STORE_KEY)
  })

  afterEach(() => {
    storageDelete(STORE_KEY)
  })

  it('refreshes candidates from the enrolled thread checkout without metadata execution', async () => {
    const context: ThreadExecutionContext = {
      projectId: 'project-1',
      threadId: 'thread-1',
      projectRoot: '/project',
      root: '/project/.copse/worktrees/thread-1',
      checkoutMode: 'worktree',
      branch: 'copse/thread-1',
    }
    const driver = new InstalledXcodeDriver()
    let scanned: { root: string; includeMetadata: boolean } | null = null
    driver.discover = (root, includeMetadata): Promise<AppleDriverDiscovery> => {
      scanned = { root, includeMetadata }
      return Promise.resolve({
        toolchain: {
          developerDir: '/Applications/Xcode.app/Contents/Developer',
          version: 'Xcode 18',
        },
        candidates: [
          {
            id: 'DemoApp.xcworkspace',
            name: 'DemoApp.xcworkspace',
            kind: 'workspace',
            schemes: [],
          },
        ],
        destinations: [],
        metadataRequiresExecution: true,
        setupMessage: null,
      })
    }
    const service = new AppleDevelopmentService({
      driver,
      supervisor: new TaskSupervisor({ store: new EmptyTaskStore() }),
      resolveContext: (projectId, threadId): Promise<ThreadExecutionContext> => {
        assert.equal(projectId, context.projectId)
        assert.equal(threadId, context.threadId)
        return Promise.resolve(context)
      },
      pluginEnabled: (): boolean => true,
      platform: 'darwin',
    })

    const state = await service.setEnrolled(
      {
        owner: { projectId: context.projectId, threadId: context.threadId },
        source: 'user',
        signal: new AbortController().signal,
      },
      true,
    )

    assert.deepEqual(scanned, {
      root: '/project/.copse/worktrees/thread-1',
      includeMetadata: false,
    })
    assert.equal(state.enrolled, true)
    assert.equal(state.candidates[0]?.id, 'DemoApp.xcworkspace')
    assert.equal(state.metadataRequiresExecution, true)
  })
})
