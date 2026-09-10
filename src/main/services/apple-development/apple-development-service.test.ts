import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type {
  SupervisedTaskArchive,
  SupervisedTaskAuditEvent,
  SupervisedTaskMeta,
} from '@shared/supervisor/task-schema.ts'
import { storageDelete, storageSet } from '../storage/storage.ts'
import type { LoadedSupervisedTasks, SupervisedTaskStore } from '../supervisor/task-store.ts'
import { TaskSupervisor } from '../supervisor/task-supervisor.ts'
import type { ThreadExecutionContext } from '../thread-execution-context.ts'
import {
  InstalledXcodeDriver,
  type AppleDriverDiscovery,
  type AppleDriverResult,
} from './apple-driver.ts'
import { AppleDevelopmentService } from './apple-development-service.ts'

const STORE_KEY = 'plugin.copse.apple-development.state'

class EmptyTaskStore implements SupervisedTaskStore {
  private readonly initialTasks: SupervisedTaskMeta[]
  readonly transitions: Array<{
    meta: SupervisedTaskMeta
    audit: SupervisedTaskAuditEvent
  }> = []

  constructor(initialTasks: SupervisedTaskMeta[] = []) {
    this.initialTasks = initialTasks
  }

  loadAll(): Promise<LoadedSupervisedTasks> {
    return Promise.resolve({ tasks: this.initialTasks, diagnostics: [] })
  }

  loadProject(): Promise<LoadedSupervisedTasks> {
    return Promise.resolve({ tasks: [], diagnostics: [] })
  }

  get(): Promise<SupervisedTaskMeta | null> {
    return Promise.resolve(null)
  }

  findPersisted(projectId: string, taskId: string): Promise<SupervisedTaskMeta | null> {
    return Promise.resolve(
      this.initialTasks.find((task) => task.projectId === projectId && task.taskId === taskId) ??
        null,
    )
  }

  saveTransition(meta: SupervisedTaskMeta, audit: SupervisedTaskAuditEvent): Promise<void> {
    this.transitions.push({ meta, audit })
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

  it('records direct user authority for an unsandboxed Apple operation', async () => {
    const context: ThreadExecutionContext = {
      projectId: 'project-1',
      threadId: 'thread-1',
      projectRoot: '/project',
      root: '/project/.copse/worktrees/thread-1',
      checkoutMode: 'worktree',
      branch: 'copse/thread-1',
    }
    const discovery: AppleDriverDiscovery = {
      toolchain: {
        developerDir: '/Applications/Xcode.app/Contents/Developer',
        version: 'Xcode 18',
      },
      candidates: [
        {
          id: 'DemoApp.xcodeproj',
          name: 'DemoApp',
          kind: 'project',
          schemes: ['DemoApp'],
        },
      ],
      destinations: [
        { id: 'platform=macOS', name: 'This Mac', platform: 'macOS', supported: true },
      ],
      metadataRequiresExecution: false,
      setupMessage: null,
    }
    const driver = new InstalledXcodeDriver()
    driver.discover = (): Promise<AppleDriverDiscovery> => Promise.resolve(discovery)
    driver.execute = (): Promise<AppleDriverResult> =>
      Promise.resolve({
        exitCode: 0,
        logs: '',
        outputTruncated: false,
        diagnostics: [],
        testSummary: null,
        appSession: { id: 'app-session-1' },
      })
    let stoppedSession: string | null = null
    driver.stopAppSession = (sessionId): Promise<boolean> => {
      stoppedSession = sessionId
      return Promise.resolve(true)
    }
    const taskStore = new EmptyTaskStore()
    const supervisor = new TaskSupervisor({
      store: taskStore,
      createId: (): string => 'operation-1',
    })
    const service = new AppleDevelopmentService({
      driver,
      supervisor,
      resolveContext: (): Promise<ThreadExecutionContext> => Promise.resolve(context),
      pluginEnabled: (): boolean => true,
      platform: 'darwin',
    })
    const invocation = {
      owner: { projectId: context.projectId, threadId: context.threadId },
      source: 'user' as const,
      signal: new AbortController().signal,
    }

    await service.setEnrolled(invocation, true)
    const selection = await service.configure(invocation, {
      candidateId: 'DemoApp.xcodeproj',
      schemeId: 'DemoApp',
      configuration: 'Debug',
      destinationId: 'platform=macOS',
      expectedRevision: 0,
    })
    const queued = await service.execute(invocation, {
      action: 'run',
      expectedRevision: selection.revision,
      requestId: 'run-1',
    })
    await supervisor.waitForIdle()

    const enqueued = taskStore.transitions.find((entry) => entry.audit.action === 'enqueue')
    assert.ok(enqueued)
    assert.equal(enqueued.meta.provenance, 'user')
    assert.equal(enqueued.meta.permissionSnapshot.projectSandboxEnabled, false)
    const authority = enqueued.meta.permissionSnapshot.extra
    assert.ok(authority)
    assert.equal(authority['pluginId'], 'copse.apple-development')
    assert.equal(authority['authority'], 'direct-user-action')
    assert.equal(typeof authority['authorityEpoch'], 'string')
    assert.equal(enqueued.meta.reapproveOnWake, true)
    assert.equal(service.operation(invocation, queued.id).operation.status, 'succeeded')
    assert.equal(
      service.operation(invocation, queued.id).operation.outcome?.appSessionId,
      'app-session-1',
    )

    assert.equal(await service.stopApp(invocation, 'app-session-1'), true)
    assert.equal(stoppedSession, 'app-session-1')
    const stopped = service.operation(invocation, queued.id).operation
    assert.equal(stopped.outcome?.appSessionId, undefined)
    assert.equal(stopped.outcome?.reason, 'App stopped.')
  })

  it('keeps discovered targets scoped to each thread checkout', async () => {
    const contexts: Record<string, ThreadExecutionContext> = {
      'thread-1': {
        projectId: 'project-1',
        threadId: 'thread-1',
        projectRoot: '/project',
        root: '/project/.copse/worktrees/thread-1',
        checkoutMode: 'worktree',
        branch: 'copse/thread-1',
      },
      'thread-2': {
        projectId: 'project-1',
        threadId: 'thread-2',
        projectRoot: '/project',
        root: '/project/.copse/worktrees/thread-2',
        checkoutMode: 'worktree',
        branch: 'copse/thread-2',
      },
    }
    const driver = new InstalledXcodeDriver()
    driver.discover = (root): Promise<AppleDriverDiscovery> =>
      Promise.resolve({
        toolchain: {
          developerDir: '/Applications/Xcode.app/Contents/Developer',
          version: 'Xcode detected',
        },
        candidates: [
          {
            id: `${root.split('/').at(-1) ?? 'unknown'}.xcodeproj`,
            name: root,
            kind: 'project',
            schemes: [],
          },
        ],
        destinations: [],
        metadataRequiresExecution: true,
        setupMessage: null,
      })
    const service = new AppleDevelopmentService({
      driver,
      supervisor: new TaskSupervisor({ store: new EmptyTaskStore() }),
      resolveContext: (_projectId, threadId): Promise<ThreadExecutionContext> => {
        const context = contexts[threadId]
        if (!context) throw new Error(`Unexpected thread: ${threadId}`)
        return Promise.resolve(context)
      },
      pluginEnabled: (): boolean => true,
      platform: 'darwin',
    })
    const signal = new AbortController().signal
    const firstOwner = { projectId: 'project-1', threadId: 'thread-1' }
    const secondOwner = { projectId: 'project-1', threadId: 'thread-2' }

    await service.setEnrolled({ owner: firstOwner, source: 'user', signal }, true)
    assert.equal(service.getState(firstOwner).candidates[0]?.id, 'thread-1.xcodeproj')
    assert.deepEqual(service.getState(secondOwner).candidates, [])

    await service.discover({ owner: secondOwner, source: 'user', signal }, false)
    assert.equal(service.getState(secondOwner).candidates[0]?.id, 'thread-2.xcodeproj')
    assert.equal(service.getState(firstOwner).candidates[0]?.id, 'thread-1.xcodeproj')
  })

  it('blocks a recovered Apple operation whose process authority expired', async () => {
    const selection = {
      candidateId: 'DemoApp.xcodeproj',
      schemeId: 'DemoApp',
      configuration: 'Debug',
      destinationId: 'platform=macOS',
      revision: 1,
    }
    const operation = {
      id: 'operation-1',
      action: 'build',
      status: 'queued',
      target: selection,
      createdAt: 1,
      updatedAt: 1,
      outcome: null,
    }
    storageSet(STORE_KEY, {
      version: 1,
      projects: {
        'project-1': {
          enrolled: true,
          threads: {
            'thread-1': {
              selection,
              operations: [
                {
                  operation,
                  logs: '',
                  requestId: 'build-1',
                  payloadHash: 'hash',
                },
              ],
            },
          },
        },
      },
    })
    const recoveredTask: SupervisedTaskMeta = {
      taskId: operation.id,
      projectId: 'project-1',
      threadId: 'thread-1',
      handler: 'apple_operation',
      handlerInput: {
        action: 'build',
        selection,
        root: '/project/.copse/worktrees/thread-1',
        checkoutMode: 'worktree',
      },
      provenance: 'agent',
      state: 'queued',
      createdAt: 1,
      updatedAt: 1,
      trigger: { kind: 'immediate' },
      permissionSnapshot: {
        capturedAt: 1,
        autoRunSandboxCommands: false,
        projectSandboxEnabled: false,
        executionRoot: '/project/.copse/worktrees/thread-1',
        workspaceTargetKind: 'local',
        extra: {
          pluginId: 'copse.apple-development',
          authority: 'per-call-agent-approval',
          authorityEpoch: 'expired-process',
        },
      },
      reapproveOnWake: true,
      concurrencyClass: 'apple:/project/.copse/worktrees/thread-1',
      resourceBudget: { maxDurationMs: 30 * 60 * 1_000, maxAttempts: 1 },
      attempt: 0,
      maxAttempts: 1,
    }
    const taskStore = new EmptyTaskStore([recoveredTask])
    const supervisor = new TaskSupervisor({ store: taskStore })
    const driver = new InstalledXcodeDriver()
    let executions = 0
    driver.execute = (): Promise<AppleDriverResult> => {
      executions += 1
      throw new Error('Recovered operation must not execute')
    }
    const service = new AppleDevelopmentService({
      driver,
      supervisor,
      pluginEnabled: (): boolean => true,
      platform: 'darwin',
    })

    await supervisor.start()
    await supervisor.waitForIdle()

    assert.equal(executions, 0)
    assert.equal(supervisor.get('project-1', operation.id)?.state, 'blocked')
    assert.equal(
      service.operation(
        {
          owner: { projectId: 'project-1', threadId: 'thread-1' },
          source: 'user',
          signal: new AbortController().signal,
        },
        operation.id,
      ).operation.outcome?.reason,
      'Apple operation requires approval again after Copse restarted.',
    )
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
