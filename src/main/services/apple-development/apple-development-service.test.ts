import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type {
  SupervisedTaskArchive,
  SupervisedTaskAuditEvent,
  SupervisedTaskMeta,
} from '@shared/supervisor/task-schema.ts'
import {
  storageDelete,
  storageGet,
  storageListFiles,
  storageReadFile,
  storageRemoveFile,
  storageSet,
  storageWriteFile,
} from '../storage/storage.ts'
import type { LoadedSupervisedTasks, SupervisedTaskStore } from '../supervisor/task-store.ts'
import { TaskSupervisor } from '../supervisor/task-supervisor.ts'
import type { ThreadExecutionContext } from '../thread-execution-context.ts'
import {
  InstalledXcodeDriver,
  type AppleDriverDiscovery,
  type AppleDriverResult,
} from './apple-driver.ts'
import { AppleDevelopmentService, type AppleInvocation } from './apple-development-service.ts'

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

  it('detects project eligibility without starting Xcode or changing enrollment', async () => {
    const roots: string[] = []
    const service = new AppleDevelopmentService({
      supervisor: new TaskSupervisor({ store: new EmptyTaskStore() }),
      pluginEnabled: (): boolean => true,
      platform: 'darwin',
      resolveProjectRoot: (projectId): string | null =>
        projectId === 'project-1' ? '/project' : null,
      detectProject: (root): Promise<boolean> => {
        roots.push(root)
        return Promise.resolve(true)
      },
    })

    assert.deepEqual(await service.detectProject('project-1'), {
      detected: true,
      enrolled: false,
      supportedHost: true,
    })
    assert.deepEqual(roots, ['/project'])
  })

  describe('open-time suggestion', () => {
    function suggestionService(
      options: { detected?: boolean; pluginOn?: boolean; suggest?: boolean } = {},
    ): AppleDevelopmentService {
      return new AppleDevelopmentService({
        supervisor: new TaskSupervisor({ store: new EmptyTaskStore() }),
        pluginEnabled: (): boolean => options.pluginOn ?? false,
        suggestionsEnabled: (): boolean => options.suggest ?? true,
        platform: 'darwin',
        resolveProjectRoot: (): string => '/project',
        detectProject: (): Promise<boolean> => Promise.resolve(options.detected ?? true),
      })
    }

    it('offers the dialog for a detected project while the plugin is still off', async () => {
      assert.deepEqual(await suggestionService().projectSuggestion('project-1'), {
        offer: 'dialog',
        pluginEnabled: false,
      })
    })

    it('reports that the plugin is already on so the dialog only asks to allow', async () => {
      assert.deepEqual(await suggestionService({ pluginOn: true }).projectSuggestion('project-1'), {
        offer: 'dialog',
        pluginEnabled: true,
      })
    })

    it('offers nothing for a project without Xcode markers', async () => {
      const suggestion = await suggestionService({ detected: false }).projectSuggestion('project-1')
      assert.equal(suggestion.offer, 'none')
    })

    it('offers nothing when the user turned suggestions off', async () => {
      const suggestion = await suggestionService({ suggest: false }).projectSuggestion('project-1')
      assert.equal(suggestion.offer, 'none')
    })

    it('turns "Not now" into a reminder and "Don\'t ask" into silence', async () => {
      const service = suggestionService()
      await service.answerSuggestion('project-1', 'snoozed')
      assert.equal((await service.projectSuggestion('project-1')).offer, 'reminder')
      await service.answerSuggestion('project-1', 'dismissed')
      assert.equal((await service.projectSuggestion('project-1')).offer, 'none')
    })

    it('stays silent for an enrolled project and after the user removes it', async () => {
      // Enrolling is refused off macOS, so the enrolled state needs a Mac host;
      // enrolling then discovers the project, which must not start real Xcode.
      const driver = new InstalledXcodeDriver()
      driver.discover = (): Promise<AppleDriverDiscovery> =>
        Promise.resolve({
          toolchain: {
            developerDir: '/Applications/Xcode.app/Contents/Developer',
            version: 'Xcode 18',
          },
          candidates: [],
          destinations: [],
          metadataRequiresExecution: false,
          setupMessage: null,
        })
      const service = new AppleDevelopmentService({
        supervisor: new TaskSupervisor({ store: new EmptyTaskStore() }),
        driver,
        pluginEnabled: (): boolean => true,
        suggestionsEnabled: (): boolean => true,
        platform: 'darwin',
        resolveProjectRoot: (): string => '/project',
        detectProject: (): Promise<boolean> => Promise.resolve(true),
        resolveContext: (projectId, threadId): Promise<ThreadExecutionContext> =>
          Promise.resolve({
            projectId,
            threadId,
            projectRoot: '/project',
            root: '/project',
            checkoutMode: 'shared',
            branch: 'main',
          }),
      })
      const invocation: AppleInvocation = {
        owner: { projectId: 'project-1', threadId: 'thread-1' },
        source: 'user',
        signal: new AbortController().signal,
      }
      await service.answerSuggestion('project-1', 'snoozed')
      await service.setEnrolled(invocation, true)
      const enrolled = await suggestionService({ pluginOn: true }).projectSuggestion('project-1')
      assert.equal(enrolled.offer, 'none')
      await service.setEnrolled(invocation, false)
      const removed = await suggestionService({ pluginOn: true }).projectSuggestion('project-1')
      assert.equal(removed.offer, 'none')
    })
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
        {
          id: 'platform=iOS Simulator,id=SIMULATOR-17',
          name: 'iPhone 17 Pro',
          platform: 'iOS Simulator',
          supported: true,
          booted: true,
        },
      ],
      metadataRequiresExecution: false,
      setupMessage: null,
    }
    const driver = new InstalledXcodeDriver()
    driver.discover = (): Promise<AppleDriverDiscovery> => Promise.resolve(discovery)
    let destinationQueries = 0
    driver.destinations = (): Promise<AppleDriverDiscovery['destinations']> => {
      destinationQueries += 1
      return Promise.resolve(discovery.destinations)
    }
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
    const presentedSimulators: string[] = []
    const service = new AppleDevelopmentService({
      driver,
      supervisor,
      resolveContext: (): Promise<ThreadExecutionContext> => Promise.resolve(context),
      pluginEnabled: (): boolean => true,
      platform: 'darwin',
      presentSimulator: (udid): void => {
        presentedSimulators.push(udid)
        throw new Error('Desktop pane unavailable')
      },
    })
    const invocation = {
      owner: { projectId: context.projectId, threadId: context.threadId },
      source: 'user' as const,
      signal: new AbortController().signal,
    }

    await service.setEnrolled(invocation, true)
    await service.destinations(invocation, 'DemoApp.xcodeproj', 'DemoApp')
    await service.destinations(invocation, 'DemoApp.xcodeproj', 'DemoApp')
    assert.equal(destinationQueries, 1)
    await service.discover(invocation, true)
    await service.destinations(invocation, 'DemoApp.xcodeproj', 'DemoApp')
    assert.equal(destinationQueries, 2)
    const selection = await service.configure(invocation, {
      candidateId: 'DemoApp.xcodeproj',
      schemeId: 'DemoApp',
      configuration: 'Debug',
      destinationId: 'platform=iOS Simulator,id=SIMULATOR-17',
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
    assert.equal((await service.operation(invocation, queued.id)).operation.status, 'succeeded')
    assert.equal(
      (await service.operation(invocation, queued.id)).operation.outcome?.appSessionId,
      'app-session-1',
    )
    assert.deepEqual(presentedSimulators, ['SIMULATOR-17'])

    assert.equal(await service.stopApp(invocation, 'app-session-1'), true)
    assert.equal(stoppedSession, 'app-session-1')
    const stopped = (await service.operation(invocation, queued.id)).operation
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
    await supervisor.acknowledgeBlock('project-1', operation.id)
    await supervisor.waitForIdle()
    assert.equal(executions, 0, 'Generic Resume cannot renew process-scoped Apple authority')
    assert.equal(supervisor.get('project-1', operation.id)?.state, 'blocked')
    assert.equal(
      (
        await service.operation(
          {
            owner: { projectId: 'project-1', threadId: 'thread-1' },
            source: 'user',
            signal: new AbortController().signal,
          },
          operation.id,
        )
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

describe('AppleDevelopmentService on a host without Xcode', () => {
  const owner = { projectId: 'linux-project', threadId: 'thread-1' }
  const context: ThreadExecutionContext = {
    ...owner,
    projectRoot: '/project',
    root: '/project',
    checkoutMode: 'shared',
    branch: null,
  }

  beforeEach(() => {
    storageDelete(STORE_KEY)
  })

  afterEach(() => {
    storageDelete(STORE_KEY)
  })

  function linuxService(pluginEnabled = true): AppleDevelopmentService {
    const driver = new InstalledXcodeDriver()
    driver.discover = (): Promise<AppleDriverDiscovery> =>
      Promise.reject(new Error('discover must not run on Linux'))
    return new AppleDevelopmentService({
      driver,
      supervisor: new TaskSupervisor({ store: new EmptyTaskStore() }),
      resolveContext: (): Promise<ThreadExecutionContext> => Promise.resolve(context),
      pluginEnabled: (): boolean => pluginEnabled,
      platform: 'linux',
    })
  }

  it('reports the host requirement instead of asking the user to enroll', () => {
    const state = linuxService().getState(owner)

    assert.equal(state.supportedHost, false)
    assert.equal(state.enrolled, false)
    assert.equal(state.setupMessage, 'Apple Development requires a local macOS host.')
  })

  it('reports the host requirement before asking to enable the plugin', () => {
    assert.equal(
      linuxService(false).getState(owner).setupMessage,
      'Apple Development requires a local macOS host.',
    )
  })

  it('refuses to enroll but still allows removing an existing enrollment', async () => {
    const service = linuxService()
    const invocation: AppleInvocation = {
      owner,
      source: 'user',
      signal: new AbortController().signal,
    }

    await assert.rejects(service.setEnrolled(invocation, true), /requires a local macOS host/)
    assert.equal(service.isProjectEnrolled(owner.projectId), false)

    storageSet(STORE_KEY, {
      version: 1,
      projects: { [owner.projectId]: { enrolled: true, threads: {} } },
    })
    const state = await service.setEnrolled(invocation, false)
    assert.equal(state.enrolled, false)
    assert.equal(service.isProjectEnrolled(owner.projectId), false)
  })
})

describe('AppleDevelopmentService build output', () => {
  const owner = { projectId: 'project-1', threadId: 'thread-1' }
  const context: ThreadExecutionContext = {
    ...owner,
    projectRoot: '/project',
    root: '/project',
    checkoutMode: 'shared',
    branch: null,
  }
  const discovery: AppleDriverDiscovery = {
    toolchain: { developerDir: '/Applications/Xcode.app/Contents/Developer', version: 'Xcode 18' },
    candidates: [
      { id: 'DemoApp.xcodeproj', name: 'DemoApp', kind: 'project', schemes: ['DemoApp'] },
    ],
    destinations: [
      {
        id: 'platform=iOS Simulator,id=SIMULATOR-17',
        name: 'iPhone 17 Pro',
        platform: 'iOS Simulator',
        supported: true,
        booted: true,
      },
    ],
    metadataRequiresExecution: false,
    setupMessage: null,
  }
  const invocation: AppleInvocation = {
    owner,
    source: 'user',
    signal: new AbortController().signal,
  }
  const LOG_DIR = 'apple-development/logs'
  const logFile = (operationId: string): string => `${LOG_DIR}/${operationId}.log`
  const selection = {
    candidateId: 'DemoApp.xcodeproj',
    schemeId: 'DemoApp',
    configuration: 'Debug',
    destinationId: 'platform=iOS Simulator,id=SIMULATOR-17',
    revision: 1,
  }
  const storedOperation = (id: string, logs?: string): Record<string, unknown> => ({
    operation: {
      id,
      action: 'build',
      status: 'queued',
      target: selection,
      createdAt: 1,
      updatedAt: 1,
      outcome: null,
    },
    ...(logs === undefined ? {} : { logs }),
    requestId: `request-${id}`,
    payloadHash: 'hash',
  })
  const seedStore = (operations: Array<Record<string, unknown>>): void => {
    storageSet(STORE_KEY, {
      version: 1,
      projects: {
        [owner.projectId]: {
          enrolled: true,
          threads: { [owner.threadId]: { selection, operations } },
        },
      },
    })
  }

  async function clearLogFiles(): Promise<void> {
    for (const name of await storageListFiles(LOG_DIR)) {
      await storageRemoveFile(`${LOG_DIR}/${name}`)
    }
  }

  beforeEach(async () => {
    storageDelete(STORE_KEY)
    await clearLogFiles()
  })

  afterEach(async () => {
    storageDelete(STORE_KEY)
    await clearLogFiles()
  })

  function newService(output = '', createId?: () => string): AppleDevelopmentService {
    const driver = new InstalledXcodeDriver()
    driver.discover = (): Promise<AppleDriverDiscovery> => Promise.resolve(discovery)
    driver.destinations = (): Promise<AppleDriverDiscovery['destinations']> =>
      Promise.resolve(discovery.destinations)
    driver.execute = (): Promise<AppleDriverResult> =>
      Promise.resolve({
        exitCode: 0,
        logs: output,
        outputTruncated: false,
        diagnostics: [],
        testSummary: null,
      })
    return new AppleDevelopmentService({
      driver,
      supervisor: new TaskSupervisor({
        store: new EmptyTaskStore(),
        ...(createId ? { createId } : {}),
      }),
      resolveContext: (): Promise<ThreadExecutionContext> => Promise.resolve(context),
      pluginEnabled: (): boolean => true,
      platform: 'darwin',
    })
  }

  async function configure(service: AppleDevelopmentService): Promise<{ revision: number }> {
    await service.setEnrolled(invocation, true)
    await service.discover(invocation, true)
    return service.configure(invocation, {
      candidateId: 'DemoApp.xcodeproj',
      schemeId: 'DemoApp',
      configuration: 'Debug',
      destinationId: 'platform=iOS Simulator,id=SIMULATOR-17',
      expectedRevision: 0,
    })
  }

  it("keeps a finished operation's output in a file, not in config.json", async () => {
    const output = 'Compiling DemoApp\nBuild succeeded'
    const service = newService(output, () => 'operation-1')
    const configured = await configure(service)

    const queued = await service.execute(invocation, {
      action: 'build',
      expectedRevision: configured.revision,
      requestId: 'build-1',
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    assert.equal((await service.operation(invocation, queued.id)).operation.status, 'succeeded')
    assert.equal(await storageReadFile(logFile(queued.id)), output)
    assert.equal((await service.operation(invocation, queued.id)).text, output)
    assert.equal(
      JSON.stringify(storageGet(STORE_KEY)).includes('Compiling DemoApp'),
      false,
      'the stored operation must not carry its output',
    )
  })

  it('pages output from the file by cursor', async () => {
    const output = 'x'.repeat(70_000)
    seedStore([storedOperation('operation-1')])
    await storageWriteFile(logFile('operation-1'), output)
    const service = newService()

    const first = await service.operation(invocation, 'operation-1')
    assert.equal(first.text.length, 64_000)
    assert.equal(first.truncated, true)
    const second = await service.operation(invocation, 'operation-1', first.nextCursor)
    assert.equal(second.text.length, 6_000)
    assert.equal(second.truncated, false)
  })

  it('moves output a profile still holds inline into files, once', async () => {
    seedStore([
      storedOperation('legacy-1', 'old build output'),
      storedOperation('legacy-empty', ''),
    ])

    const service = newService()

    assert.equal((await service.operation(invocation, 'legacy-1')).text, 'old build output')
    assert.equal(await storageReadFile(logFile('legacy-1')), 'old build output')
    assert.equal(
      JSON.stringify(storageGet(STORE_KEY)).includes('old build output'),
      false,
      'the config copy is gone once it is in a file',
    )
    assert.equal((await service.operation(invocation, 'legacy-empty')).text, '')
  })

  it('keeps an existing output file rather than overwriting it with a stale inline copy', async () => {
    seedStore([storedOperation('operation-1', 'stale inline copy')])
    await storageWriteFile(logFile('operation-1'), 'the newer file')

    const service = newService()

    assert.equal((await service.operation(invocation, 'operation-1')).text, 'the newer file')
  })

  it('removes output files that no stored operation refers to when it starts', async () => {
    seedStore([storedOperation('operation-1')])
    await storageWriteFile(logFile('operation-1'), 'referenced')
    await storageWriteFile(logFile('orphan'), 'nothing points here')
    await storageWriteFile(`${LOG_DIR}/leftover.log.1234.tmp`, 'a write in progress elsewhere')

    const service = newService()
    // Reading output waits for the start-up tidy to finish.
    await service.operation(invocation, 'operation-1')

    assert.deepEqual((await storageListFiles(LOG_DIR)).sort(), [
      'leftover.log.1234.tmp',
      'operation-1.log',
    ])
  })

  it('deletes the output of an operation that falls off the end of a thread list', async () => {
    const ids = Array.from({ length: 50 }, (_, index) => `old-${String(index)}`)
    const service = newService('fresh output', () => 'operation-new')
    const configured = await configure(service)
    // Fifty operations are already on the thread; the next one evicts the oldest.
    storageSet(STORE_KEY, {
      version: 1,
      projects: {
        [owner.projectId]: {
          enrolled: true,
          threads: {
            [owner.threadId]: {
              selection: { ...selection, revision: configured.revision },
              operations: ids.map((id) => storedOperation(id)),
            },
          },
        },
      },
    })
    for (const id of ids) await storageWriteFile(logFile(id), `output of ${id}`)

    await service.execute(invocation, {
      action: 'build',
      expectedRevision: configured.revision,
      requestId: 'build-new',
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    const files = await storageListFiles(LOG_DIR)
    assert.equal(files.includes('old-0.log'), false, 'the evicted operation loses its file')
    assert.equal(files.includes('old-1.log'), true)
    assert.equal(files.includes('operation-new.log'), true)
  })

  it('refuses an operation id that is not a plain identifier when reading output', async () => {
    seedStore([storedOperation('../../config')])
    await storageWriteFile(logFile('real'), 'secret')
    const service = newService()

    assert.equal((await service.operation(invocation, '../../config')).text, '')
  })
})
