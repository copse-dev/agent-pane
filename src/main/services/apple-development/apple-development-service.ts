import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { APPLE_DEVELOPMENT_PLUGIN_ID } from '@copse/agent/plugins/apple-development-plugin.ts'
import { getDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import {
  appleOperationSchema,
  appleSelectionSchema,
  type AppleConfigureInput,
  type AppleExecuteInput,
  type AppleOperation,
  type AppleOperationLogPage,
  type AppleProjectState,
  type AppleSelection,
} from '@shared/types/apple-development.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { storageGet, storageUpdate } from '../storage/storage.ts'
import {
  resolveThreadExecutionContext,
  type ThreadExecutionOwner,
} from '../thread-execution-context.ts'
import { getTaskSupervisor, type TaskSupervisor } from '../supervisor/task-supervisor.ts'
import type { SupervisedTaskMeta } from '@shared/supervisor/task-schema.ts'
import {
  InstalledXcodeDriver,
  type AppleDriverDiscovery,
  type AppleDriverPlan,
} from './apple-driver.ts'

const STORE_KEY = 'plugin.copse.apple-development.state'
const APPLE_HANDLER = 'apple_operation'
const MAX_LOG_CHARS = 1_000_000
const LOG_PAGE_CHARS = 64_000
const APPLE_AUTHORITY_EPOCH = randomUUID()

const storedOperationSchema = z.object({
  operation: appleOperationSchema,
  logs: z.string().max(MAX_LOG_CHARS),
  requestId: z.string().min(1).max(256),
  payloadHash: z.string().min(1),
})

const storedThreadSchema = z.object({
  selection: appleSelectionSchema.nullable(),
  operations: z.array(storedOperationSchema).max(50),
})

const storedProjectSchema = z.object({
  enrolled: z.boolean(),
  threads: z.record(z.string(), storedThreadSchema),
})

const appleStoreSchema = z.object({
  version: z.literal(1),
  projects: z.record(z.string(), storedProjectSchema),
})

type AppleStore = z.infer<typeof appleStoreSchema>
type StoredOperation = z.infer<typeof storedOperationSchema>

const emptyStore = (): AppleStore => ({ version: 1, projects: {} })

export interface AppleInvocation {
  owner: ThreadExecutionOwner
  source: 'user' | 'agent'
  turnTreeId?: string
  signal: AbortSignal
}

export interface AppleDevelopmentServiceDependencies {
  driver?: InstalledXcodeDriver
  supervisor?: TaskSupervisor
  resolveContext?: typeof resolveThreadExecutionContext
  pluginEnabled?: () => boolean
  platform?: NodeJS.Platform
}

function readStore(): AppleStore {
  const parsed = appleStoreSchema.safeParse(storageGet(STORE_KEY))
  return parsed.success ? parsed.data : emptyStore()
}

/** Project-scoped activation gate used before Apple schemas reach any agent. */
export function isAppleDevelopmentProjectEnrolled(projectId: string): boolean {
  return readStore().projects[projectId]?.enrolled === true
}

function threadState(
  store: AppleStore,
  owner: ThreadExecutionOwner,
): z.infer<typeof storedThreadSchema> {
  return (
    store.projects[owner.projectId]?.threads[owner.threadId] ?? {
      selection: null,
      operations: [],
    }
  )
}

function payloadHash(input: AppleExecuteInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

function isRemoteProject(projectId: string): boolean {
  const projects: unknown = storageGet('projects')
  if (!Array.isArray(projects)) return false
  const project: unknown = projects.find(
    (candidate: unknown) => isRecord(candidate) && candidate['id'] === projectId,
  )
  return isRecord(project) && typeof project['sshHost'] === 'string' && project['sshHost'] !== ''
}

function setupMessage(
  pluginEnabled: boolean,
  enrolled: boolean,
  platform: NodeJS.Platform,
  discovery: AppleDriverDiscovery | undefined,
  selection: AppleSelection | null,
): string | null {
  if (!pluginEnabled) return 'Enable Apple Development in Settings → Plugins.'
  if (!enrolled) return 'Enroll this project to use Apple Development.'
  if (platform !== 'darwin') return 'Apple Development requires a local macOS host.'
  if (!discovery) return 'Discover the installed Xcode and project targets to continue.'
  if (discovery.setupMessage) return discovery.setupMessage
  if (!selection) return 'Choose a workspace or project, scheme, configuration, and destination.'
  return null
}

function operationStatus(task: SupervisedTaskMeta | null, stored: AppleOperation): AppleOperation {
  if (!task || stored.status === 'succeeded' || stored.status === 'failed') return stored
  if (task.state === 'cancelled')
    return { ...stored, status: 'cancelled', updatedAt: task.updatedAt }
  if (task.state === 'running') return { ...stored, status: 'running', updatedAt: task.updatedAt }
  return stored
}

export class AppleDevelopmentService {
  private readonly driver: InstalledXcodeDriver
  private readonly supervisor: TaskSupervisor
  private readonly resolveContext: typeof resolveThreadExecutionContext
  private readonly pluginEnabled: () => boolean
  private readonly platform: NodeJS.Platform
  private readonly discoveries = new Map<string, Map<string, AppleDriverDiscovery>>()
  private readonly leases = new Map<string, Promise<void>>()

  constructor(dependencies: AppleDevelopmentServiceDependencies = {}) {
    this.driver = dependencies.driver ?? new InstalledXcodeDriver()
    this.supervisor = dependencies.supervisor ?? getTaskSupervisor()
    this.resolveContext = dependencies.resolveContext ?? resolveThreadExecutionContext
    this.pluginEnabled =
      dependencies.pluginEnabled ??
      ((): boolean => getDefaultPluginRegistry().isEnabled(APPLE_DEVELOPMENT_PLUGIN_ID))
    this.platform = dependencies.platform ?? process.platform
    this.supervisor.registerHandler(APPLE_HANDLER, (task, context) =>
      this.handleOperation(task, context.signal),
    )
    this.supervisor.subscribe((task) => {
      if (task.handler !== APPLE_HANDLER || task.state !== 'cancelled') return
      void this.updateOperation(task.projectId, task.threadId, task.taskId, (operation) => ({
        ...operation,
        status: 'cancelled',
        updatedAt: task.updatedAt,
        outcome: {
          operationId: task.taskId,
          status: 'cancelled',
          reason: 'Cancellation requested.',
          exitCode: null,
          diagnostics: [],
          testSummary: null,
          logArtifactId: `apple-log:${task.taskId}`,
          outputTruncated: false,
        },
      }))
    })
  }

  private async updateStore(update: (store: AppleStore) => AppleStore): Promise<void> {
    await storageUpdate(STORE_KEY, (raw) => {
      const parsed = appleStoreSchema.safeParse(raw)
      return update(parsed.success ? parsed.data : emptyStore())
    })
  }

  private discovery(owner: ThreadExecutionOwner): AppleDriverDiscovery | undefined {
    return this.discoveries.get(owner.projectId)?.get(owner.threadId)
  }

  private setDiscovery(owner: ThreadExecutionOwner, discovery: AppleDriverDiscovery): void {
    const project = this.discoveries.get(owner.projectId) ?? new Map<string, AppleDriverDiscovery>()
    project.set(owner.threadId, discovery)
    this.discoveries.set(owner.projectId, project)
  }

  private async updateOperation(
    projectId: string,
    threadId: string,
    operationId: string,
    update: (operation: AppleOperation) => AppleOperation,
    logs?: string,
  ): Promise<void> {
    await this.updateStore((store) => {
      const project = store.projects[projectId]
      const thread = project?.threads[threadId]
      if (!project || !thread) return store
      return {
        ...store,
        projects: {
          ...store.projects,
          [projectId]: {
            ...project,
            threads: {
              ...project.threads,
              [threadId]: {
                ...thread,
                operations: thread.operations.map((entry) =>
                  entry.operation.id === operationId
                    ? {
                        ...entry,
                        operation: update(entry.operation),
                        ...(logs !== undefined ? { logs: logs.slice(-MAX_LOG_CHARS) } : {}),
                      }
                    : entry,
                ),
              },
            },
          },
        },
      }
    })
  }

  async setEnrolled(invocation: AppleInvocation, enrolled: boolean): Promise<AppleProjectState> {
    if (!this.pluginEnabled()) throw new Error('Apple Development is disabled.')
    const { projectId, threadId } = invocation.owner
    const context = await this.resolveContext(projectId, threadId)
    await this.updateStore((store) => {
      const current = store.projects[projectId] ?? { enrolled: false, threads: {} }
      return {
        ...store,
        projects: {
          ...store.projects,
          [projectId]: { ...current, enrolled },
        },
      }
    })
    if (!enrolled) {
      this.discoveries.delete(projectId)
      await this.cancelProject(projectId)
    } else if (this.platform === 'darwin' && !isRemoteProject(projectId)) {
      const discovery = await this.driver.discover(context.root, false, invocation.signal)
      this.setDiscovery(invocation.owner, discovery)
    }
    return this.getState(invocation.owner)
  }

  isProjectEnrolled(projectId: string): boolean {
    return isAppleDevelopmentProjectEnrolled(projectId)
  }

  getState(owner: ThreadExecutionOwner): AppleProjectState {
    const enabled = this.pluginEnabled()
    const store = readStore()
    const enrolled = store.projects[owner.projectId]?.enrolled === true
    const thread = threadState(store, owner)
    const discovery = this.discovery(owner)
    const operations = thread.operations
      .map((entry) =>
        operationStatus(this.supervisor.get(owner.projectId, entry.operation.id), entry.operation),
      )
      .sort((left, right) => right.createdAt - left.createdAt)
    return {
      pluginEnabled: enabled,
      enrolled,
      supportedHost: this.platform === 'darwin' && !isRemoteProject(owner.projectId),
      toolchain: discovery?.toolchain ?? null,
      candidates: discovery?.candidates ?? [],
      destinations: discovery?.destinations ?? [],
      metadataRequiresExecution: discovery?.metadataRequiresExecution ?? false,
      selection: thread.selection,
      operations,
      setupMessage: isRemoteProject(owner.projectId)
        ? 'Remote projects are not a supported Apple Development execution target.'
        : setupMessage(enabled, enrolled, this.platform, discovery, thread.selection),
    }
  }

  private requireEligible(owner: ThreadExecutionOwner): void {
    if (!this.pluginEnabled()) throw new Error('Apple Development is disabled.')
    if (!this.isProjectEnrolled(owner.projectId)) {
      throw new Error('This project is not enrolled in Apple Development.')
    }
    if (this.platform !== 'darwin') throw new Error('Apple Development requires a macOS host.')
    if (isRemoteProject(owner.projectId)) {
      throw new Error('Remote projects are not a supported Apple Development execution target.')
    }
  }

  async discover(
    invocation: AppleInvocation,
    includeMetadata: boolean,
  ): Promise<AppleProjectState> {
    this.requireEligible(invocation.owner)
    const context = await this.resolveContext(invocation.owner.projectId, invocation.owner.threadId)
    const discovery = await this.driver.discover(context.root, includeMetadata, invocation.signal)
    this.setDiscovery(invocation.owner, discovery)
    return this.getState(invocation.owner)
  }

  async configure(
    invocation: AppleInvocation,
    input: AppleConfigureInput,
  ): Promise<AppleSelection> {
    this.requireEligible(invocation.owner)
    const discovery = this.discovery(invocation.owner)
    if (!discovery) throw new Error('Run apple_discover before configuring a target.')
    const store = readStore()
    const current = threadState(store, invocation.owner).selection
    if ((current?.revision ?? 0) !== input.expectedRevision) {
      throw new Error(
        'The Apple target selection changed; discover and retry with its new revision.',
      )
    }
    const candidate = discovery.candidates.find((item) => item.id === input.candidateId)
    if (!candidate || !candidate.schemes.includes(input.schemeId)) {
      throw new Error('The selected Xcode project or scheme is no longer available.')
    }
    const destination = discovery.destinations.find((item) => item.id === input.destinationId)
    if (!destination?.supported) throw new Error('The selected destination is unavailable.')
    const selection: AppleSelection = {
      candidateId: candidate.id,
      schemeId: input.schemeId,
      configuration: input.configuration,
      destinationId: destination.id,
      revision: (current?.revision ?? 0) + 1,
    }
    await this.updateStore((next) => {
      const project = next.projects[invocation.owner.projectId] ?? {
        enrolled: true,
        threads: {},
      }
      const thread = project.threads[invocation.owner.threadId] ?? {
        selection: null,
        operations: [],
      }
      return {
        ...next,
        projects: {
          ...next.projects,
          [invocation.owner.projectId]: {
            ...project,
            threads: {
              ...project.threads,
              [invocation.owner.threadId]: { ...thread, selection },
            },
          },
        },
      }
    })
    return selection
  }

  async execute(invocation: AppleInvocation, input: AppleExecuteInput): Promise<AppleOperation> {
    this.requireEligible(invocation.owner)
    const context = await this.resolveContext(invocation.owner.projectId, invocation.owner.threadId)
    const store = readStore()
    const thread = threadState(store, invocation.owner)
    const selection = thread.selection
    if (!selection || selection.revision !== input.expectedRevision) {
      throw new Error('The Apple target selection is stale; discover and configure it again.')
    }
    const hash = payloadHash(input)
    const retried = thread.operations.find((entry) => entry.requestId === input.requestId)
    if (retried) {
      if (retried.payloadHash !== hash) {
        throw new Error('This Apple request ID was already used with a different payload.')
      }
      return operationStatus(
        this.supervisor.get(invocation.owner.projectId, retried.operation.id),
        retried.operation,
      )
    }

    const task = await this.supervisor.enqueue({
      projectId: invocation.owner.projectId,
      threadId: invocation.owner.threadId,
      handler: APPLE_HANDLER,
      handlerInput: {
        action: input.action,
        selection,
        root: context.root,
        checkoutMode: context.checkoutMode,
        ...(input.testFilter ? { testFilter: input.testFilter } : {}),
      },
      provenance: invocation.source,
      trigger: { kind: 'immediate' },
      permissionSnapshot: {
        capturedAt: Date.now(),
        autoRunSandboxCommands: false,
        projectSandboxEnabled: false,
        executionRoot: context.root,
        workspaceTargetKind: 'local',
        extra: {
          pluginId: APPLE_DEVELOPMENT_PLUGIN_ID,
          authority:
            invocation.source === 'user' ? 'direct-user-action' : 'per-call-agent-approval',
          authorityEpoch: APPLE_AUTHORITY_EPOCH,
        },
      },
      // A restarted host cannot prove the old Xcode process stopped. The
      // process-lifetime authority epoch lets the initial run start, then blocks
      // every recovered operation before it can launch another host process.
      reapproveOnWake: true,
      concurrencyClass: `apple:${context.root}`,
      resourceBudget: { maxDurationMs: 30 * 60 * 1_000, maxAttempts: 1 },
      maxAttempts: 1,
      ...(invocation.turnTreeId ? { turnId: invocation.turnTreeId } : {}),
    })
    const operation: AppleOperation = {
      id: task.taskId,
      action: input.action,
      status: 'queued',
      target: selection,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      outcome: null,
    }
    await this.updateStore((next) => {
      const project = next.projects[invocation.owner.projectId] ?? {
        enrolled: true,
        threads: {},
      }
      const current = project.threads[invocation.owner.threadId] ?? {
        selection,
        operations: [],
      }
      const entry: StoredOperation = {
        operation,
        logs: '',
        requestId: input.requestId,
        payloadHash: hash,
      }
      return {
        ...next,
        projects: {
          ...next.projects,
          [invocation.owner.projectId]: {
            ...project,
            threads: {
              ...project.threads,
              [invocation.owner.threadId]: {
                ...current,
                operations: [...current.operations, entry].slice(-50),
              },
            },
          },
        },
      }
    })
    return operation
  }

  private async withLease<T>(key: string, run: () => Promise<T>): Promise<T> {
    const prior = this.leases.get(key) ?? Promise.resolve()
    let release = (): void => {}
    const current = new Promise<void>((resolveRelease) => {
      release = resolveRelease
    })
    const queued = prior.then(() => current)
    this.leases.set(key, queued)
    await prior
    try {
      return await run()
    } finally {
      release()
      if (this.leases.get(key) === queued) this.leases.delete(key)
    }
  }

  private async handleOperation(
    task: SupervisedTaskMeta,
    signal: AbortSignal,
  ): Promise<{ resultRef: { kind: 'handler'; ref: string } } | { blockedReason: string }> {
    const input = task.handlerInput
    const action = input?.['action']
    const selectionParsed = appleSelectionSchema.safeParse(input?.['selection'])
    const capturedRoot = input?.['root']
    const testFilter = input?.['testFilter']
    if (
      (action !== 'build' && action !== 'test' && action !== 'run') ||
      !selectionParsed.success ||
      typeof capturedRoot !== 'string' ||
      (testFilter !== undefined && typeof testFilter !== 'string')
    ) {
      throw new Error('Stored Apple operation input is invalid.')
    }
    if (
      task.reapproveOnWake &&
      task.permissionSnapshot.extra?.['authorityEpoch'] !== APPLE_AUTHORITY_EPOCH
    ) {
      const reason = 'Apple operation requires approval again after Copse restarted.'
      await this.updateOperation(task.projectId, task.threadId, task.taskId, (operation) => ({
        ...operation,
        status: 'failed',
        updatedAt: Date.now(),
        outcome: {
          operationId: task.taskId,
          status: 'failed',
          reason,
          exitCode: null,
          diagnostics: [],
          testSummary: null,
          logArtifactId: `apple-log:${task.taskId}`,
          outputTruncated: false,
        },
      }))
      return { blockedReason: reason }
    }
    await this.updateOperation(task.projectId, task.threadId, task.taskId, (operation) => ({
      ...operation,
      status: 'running',
      updatedAt: Date.now(),
    }))
    try {
      this.requireEligible({ projectId: task.projectId, threadId: task.threadId })
      const context = await this.resolveContext(task.projectId, task.threadId)
      if (context.root !== capturedRoot) throw new Error('The captured checkout was replaced.')
      const current = threadState(readStore(), {
        projectId: task.projectId,
        threadId: task.threadId,
      }).selection
      if (current?.revision !== selectionParsed.data.revision) {
        throw new Error('The Apple target selection changed before execution.')
      }
      const owner = { projectId: task.projectId, threadId: task.threadId }
      const discovery =
        this.discovery(owner) ?? (await this.driver.discover(context.root, false, signal))
      if (!discovery.toolchain) throw new Error(discovery.setupMessage ?? 'Xcode is unavailable.')
      const toolchain = discovery.toolchain
      const plan: AppleDriverPlan = {
        operationId: task.taskId,
        root: context.root,
        target: selectionParsed.data,
        action,
        ...(testFilter ? { testFilter } : {}),
      }
      const leaseKey =
        action === 'run'
          ? `destination:${selectionParsed.data.destinationId}`
          : `checkout:${context.root}`
      const result = await this.withLease(leaseKey, () =>
        this.driver.execute(plan, toolchain.developerDir, signal),
      )
      const succeeded = result.exitCode === 0
      const now = Date.now()
      await this.updateOperation(
        task.projectId,
        task.threadId,
        task.taskId,
        (operation) => ({
          ...operation,
          status: succeeded ? 'succeeded' : 'failed',
          updatedAt: now,
          outcome: {
            operationId: task.taskId,
            status: succeeded ? 'succeeded' : 'failed',
            ...(!succeeded
              ? {
                  reason:
                    result.failureReason ??
                    `${action} exited with code ${String(result.exitCode)}.`,
                }
              : {}),
            exitCode: result.exitCode,
            diagnostics: result.diagnostics,
            testSummary: result.testSummary,
            logArtifactId: `apple-log:${task.taskId}`,
            ...(result.resultBundlePath
              ? { resultBundleArtifactId: `apple-result:${task.taskId}` }
              : {}),
            ...(result.appSession ? { appSessionId: result.appSession.id } : {}),
            outputTruncated: result.outputTruncated,
          },
        }),
        result.logs,
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await this.updateOperation(
        task.projectId,
        task.threadId,
        task.taskId,
        (operation) => ({
          ...operation,
          status: signal.aborted ? 'cancelled' : 'failed',
          updatedAt: Date.now(),
          outcome: {
            operationId: task.taskId,
            status: signal.aborted ? 'cancelled' : 'failed',
            reason,
            exitCode: null,
            diagnostics: [],
            testSummary: null,
            logArtifactId: `apple-log:${task.taskId}`,
            outputTruncated: false,
          },
        }),
        reason,
      )
    }
    return { resultRef: { kind: 'handler', ref: `apple-operation:${task.taskId}` } }
  }

  operation(invocation: AppleInvocation, operationId: string, cursor = 0): AppleOperationLogPage {
    const entry = threadState(readStore(), invocation.owner).operations.find(
      (candidate) => candidate.operation.id === operationId,
    )
    if (!entry) throw new Error('No Apple operation with that ID belongs to this thread.')
    const operation = operationStatus(
      this.supervisor.get(invocation.owner.projectId, operationId),
      entry.operation,
    )
    const safeCursor = Math.min(cursor, entry.logs.length)
    const text = entry.logs.slice(safeCursor, safeCursor + LOG_PAGE_CHARS)
    return {
      operation,
      text,
      nextCursor: safeCursor + text.length,
      truncated: safeCursor + text.length < entry.logs.length,
    }
  }

  async cancel(invocation: AppleInvocation, operationId: string): Promise<AppleOperation> {
    this.operation(invocation, operationId)
    await this.supervisor.cancel(invocation.owner.projectId, operationId)
    return this.operation(invocation, operationId).operation
  }

  async stopApp(invocation: AppleInvocation, appSessionId: string): Promise<boolean> {
    const owned = threadState(readStore(), invocation.owner).operations.some(
      (entry) => entry.operation.outcome?.appSessionId === appSessionId,
    )
    if (!owned) throw new Error('No app session with that ID belongs to this thread.')
    const context = await this.resolveContext(invocation.owner.projectId, invocation.owner.threadId)
    return this.driver.stopAppSession(appSessionId, context.root, invocation.signal)
  }

  async cancelProject(projectId: string): Promise<void> {
    const active = this.supervisor
      .list(projectId)
      .filter(
        (task) =>
          task.handler === APPLE_HANDLER &&
          (task.state === 'queued' || task.state === 'running' || task.state === 'waiting'),
      )
    await Promise.all(active.map((task) => this.supervisor.cancel(projectId, task.taskId)))
  }
}

let singleton: AppleDevelopmentService | null = null

export function getAppleDevelopmentService(): AppleDevelopmentService {
  singleton ??= new AppleDevelopmentService()
  return singleton
}

export function resetAppleDevelopmentServiceForTests(): void {
  singleton = null
}
