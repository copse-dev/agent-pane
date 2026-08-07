import { randomUUID } from 'node:crypto'
import {
  isTerminalTaskState,
  supervisedTaskMetaSchema,
  type PermissionSnapshot,
  type SupervisedTaskAuditEvent,
  type SupervisedTaskMeta,
  type TaskProvenance,
  type TaskResourceBudget,
  type TaskResultRef,
  type TaskState,
  type TaskTrigger,
} from '@shared/supervisor/task-schema.ts'
import { reconcileSupervisedTasks } from '@shared/supervisor/reconcile.ts'
import { AUTOMATIONS_PLUGIN_ID } from '@copse/agent/plugins/automations-plugin.ts'
import { getDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { nextCronOccurrence, validateCronExpression } from '../automations/cron.ts'
import {
  FileSupervisedTaskStore,
  type SupervisedTaskStore,
  type TaskLoadDiagnostic,
} from './task-store.ts'

export interface SupervisedTaskHandlerContext {
  signal: AbortSignal
}

export interface SupervisedTaskHandlerResult {
  resultRef?: TaskResultRef
  blockedReason?: string
}

export type SupervisedTaskHandler = (
  task: SupervisedTaskMeta,
  context: SupervisedTaskHandlerContext,
) => Promise<SupervisedTaskHandlerResult>

export interface EnqueueSupervisedTaskInput {
  projectId: string
  threadId: string
  parentTaskId?: string
  handler: string
  provenance: TaskProvenance
  trigger: TaskTrigger
  permissionSnapshot: PermissionSnapshot
  reapproveOnWake: boolean
  concurrencyClass: string
  resourceBudget?: TaskResourceBudget
  maxAttempts: number
  contentHash?: string
  turnId?: string
  agentId?: string
}

export interface TaskSupervisorClock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> | number
  clearTimeout(handle: ReturnType<typeof setTimeout> | number): void
}

export interface TaskSupervisorDependencies {
  store?: SupervisedTaskStore
  clock?: TaskSupervisorClock
  createId?: () => string
  onDiagnostic?: (diagnostic: TaskLoadDiagnostic) => void
  onError?: (error: unknown) => void
  maxConcurrent?: number
  concurrencyClassLimits?: Readonly<Record<string, number>>
  terminalRetentionMs?: number
  cronEnabled?: () => boolean
}

export type SupervisedEventSourceStart = (emit: (event: string) => void) => (() => void) | undefined
export type SupervisedTaskListener = (task: SupervisedTaskMeta) => void
export type SupervisedExternalTaskCanceller = (task: SupervisedTaskMeta) => void | Promise<void>
export const DEFAULT_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
const MAX_TIMER_DELAY_MS = 2_147_000_000

const systemClock: TaskSupervisorClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle)
  },
}

function auditEvent(
  task: SupervisedTaskMeta,
  action: SupervisedTaskAuditEvent['action'],
  toState: TaskState,
  at: number,
  reason?: string,
): SupervisedTaskAuditEvent {
  return {
    v: 1,
    id: randomUUID(),
    taskId: task.taskId,
    action,
    at,
    ...(task.state !== toState ? { fromState: task.state } : {}),
    toState,
    actor: 'system',
    ...(reason ? { reason } : {}),
  }
}

function withoutLastError(task: SupervisedTaskMeta): SupervisedTaskMeta {
  const { lastError: _drop, ...next } = task
  return next
}

function taskKey(projectId: string, taskId: string): string {
  return `${projectId}\0${taskId}`
}

export class TaskSupervisor {
  private readonly store: SupervisedTaskStore
  private readonly clock: TaskSupervisorClock
  private readonly createId: () => string
  private readonly onDiagnostic: (diagnostic: TaskLoadDiagnostic) => void
  private readonly onError: (error: unknown) => void
  private readonly maxConcurrent: number
  private readonly concurrencyClassLimits: Readonly<Record<string, number>>
  private readonly terminalRetentionMs: number
  private readonly cronEnabled: () => boolean
  private readonly tasks = new Map<string, SupervisedTaskMeta>()
  private readonly handlers = new Map<string, SupervisedTaskHandler>()
  private readonly externalCancellers = new Map<string, SupervisedExternalTaskCanceller>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout> | number>()
  private readonly eventWaiters = new Map<string, Set<string>>()
  private readonly eventSources = new Map<string, { references: number; dispose: () => void }>()
  private readonly listeners = new Set<SupervisedTaskListener>()
  private readonly pending = new Set<string>()
  private readonly active = new Map<string, Promise<void>>()
  private readonly abortControllers = new Map<string, AbortController>()
  private startPromise: Promise<void> | null = null
  private stopping = false

  constructor(dependencies: TaskSupervisorDependencies = {}) {
    const maxConcurrent = dependencies.maxConcurrent ?? 4
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error('Task supervisor max concurrency must be a positive integer')
    }
    for (const [concurrencyClass, limit] of Object.entries(
      dependencies.concurrencyClassLimits ?? {},
    )) {
      if (concurrencyClass.trim() === '' || !Number.isInteger(limit) || limit < 1) {
        throw new Error('Task supervisor concurrency class limits must be positive integers')
      }
    }
    this.store = dependencies.store ?? new FileSupervisedTaskStore()
    this.clock = dependencies.clock ?? systemClock
    this.createId = dependencies.createId ?? randomUUID
    this.onDiagnostic =
      dependencies.onDiagnostic ??
      ((diagnostic): void => {
        console.warn(`[task-supervisor] ${diagnostic.path}: ${diagnostic.reason}`)
      })
    this.onError =
      dependencies.onError ??
      ((error): void => {
        console.error('[task-supervisor] Task execution failed:', error)
      })
    this.maxConcurrent = maxConcurrent
    this.concurrencyClassLimits = dependencies.concurrencyClassLimits ?? {}
    this.terminalRetentionMs = dependencies.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS
    if (!Number.isFinite(this.terminalRetentionMs) || this.terminalRetentionMs < 0) {
      throw new Error('Task supervisor terminal retention must be a non-negative duration')
    }
    this.cronEnabled = dependencies.cronEnabled ?? ((): boolean => false)
  }

  registerHandler(kind: string, handler: SupervisedTaskHandler): () => void {
    if (kind.trim() === '') throw new Error('Supervised task handler kind is required')
    if (this.handlers.has(kind)) throw new Error(`Supervised task handler "${kind}" is registered`)
    this.handlers.set(kind, handler)
    return () => {
      if (this.handlers.get(kind) === handler) this.handlers.delete(kind)
    }
  }

  registerExternalCanceller(kind: string, canceller: SupervisedExternalTaskCanceller): () => void {
    if (kind.trim() === '') throw new Error('Supervised external task kind is required')
    if (this.externalCancellers.has(kind)) {
      throw new Error(`Supervised external task canceller "${kind}" is registered`)
    }
    this.externalCancellers.set(kind, canceller)
    return () => {
      if (this.externalCancellers.get(kind) === canceller) {
        this.externalCancellers.delete(kind)
      }
    }
  }

  subscribe(listener: SupervisedTaskListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  registerEventSource(sourceKey: string, start: SupervisedEventSourceStart): () => void {
    if (sourceKey.trim() === '') throw new Error('Supervised event source key is required')
    const existing = this.eventSources.get(sourceKey)
    if (existing) {
      existing.references++
      let released = false
      return () => {
        if (released) return
        released = true
        this.releaseEventSource(sourceKey, existing)
      }
    }
    const stop =
      start((event) => {
        void this.emitEvent(event).catch(this.onError)
      }) ?? ((): void => {})
    const registration = { references: 1, dispose: stop }
    this.eventSources.set(sourceKey, registration)
    let released = false
    return () => {
      if (released) return
      released = true
      this.releaseEventSource(sourceKey, registration)
    }
  }

  start(): Promise<void> {
    this.startPromise ??= this.startInternal()
    return this.startPromise
  }

  async enqueue(input: EnqueueSupervisedTaskInput): Promise<SupervisedTaskMeta> {
    await this.start()
    if (input.trigger.kind === 'cron') {
      if (!this.cronEnabled()) throw new Error('Recurring supervised tasks are disabled')
      validateCronExpression(input.trigger.expression)
    }
    const now = this.clock.now()
    const state: TaskState =
      input.trigger.kind === 'event' ||
      input.trigger.kind === 'cron' ||
      (input.trigger.kind === 'wake_at' && input.trigger.wakeAt > now)
        ? 'waiting'
        : 'queued'
    const task = supervisedTaskMetaSchema.parse({
      taskId: this.createId(),
      projectId: input.projectId,
      threadId: input.threadId,
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      handler: input.handler,
      provenance: input.provenance,
      state,
      createdAt: now,
      updatedAt: now,
      trigger: input.trigger,
      permissionSnapshot: input.permissionSnapshot,
      reapproveOnWake: input.reapproveOnWake,
      concurrencyClass: input.concurrencyClass,
      ...(input.resourceBudget ? { resourceBudget: input.resourceBudget } : {}),
      attempt: 0,
      maxAttempts: input.maxAttempts,
      ...(input.contentHash ? { contentHash: input.contentHash } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
    })
    await this.store.saveTransition(task, auditEvent(task, 'enqueue', state, now))
    this.tasks.set(taskKey(task.projectId, task.taskId), task)
    this.notify(task)
    this.arm(task)
    return task
  }

  syncCronTasks(): void {
    for (const task of this.tasks.values()) {
      if (task.trigger.kind !== 'cron' || task.state !== 'waiting') continue
      const key = taskKey(task.projectId, task.taskId)
      this.clearTimer(key)
      if (this.cronEnabled()) this.arm(task)
    }
  }

  async emitEvent(event: string): Promise<number> {
    await this.start()
    if (event.trim() === '') throw new Error('Supervised task event name is required')
    const waiters = this.eventWaiters.get(event)
    if (!waiters || waiters.size === 0) return 0
    this.eventWaiters.delete(event)
    let woken = 0
    for (const key of waiters) {
      const task = this.tasks.get(key)
      if (
        !task ||
        task.state !== 'waiting' ||
        task.trigger.kind !== 'event' ||
        task.trigger.event !== event
      ) {
        continue
      }
      try {
        const queued = await this.transition(task, 'queued', 'wake', `event:${event}`)
        this.enqueueReady(taskKey(queued.projectId, queued.taskId))
        woken++
      } catch (error) {
        this.arm(task)
        throw error
      }
    }
    return woken
  }

  async adoptRunning(
    input: EnqueueSupervisedTaskInput,
    processHandle: string,
  ): Promise<SupervisedTaskMeta> {
    await this.start()
    if (input.trigger.kind !== 'immediate') {
      throw new Error('An adopted external task must use an immediate trigger')
    }
    if (processHandle.trim() === '') throw new Error('An adopted process handle is required')
    const now = this.clock.now()
    const queued = supervisedTaskMetaSchema.parse({
      taskId: this.createId(),
      projectId: input.projectId,
      threadId: input.threadId,
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      handler: input.handler,
      provenance: input.provenance,
      state: 'queued',
      createdAt: now,
      updatedAt: now,
      trigger: input.trigger,
      permissionSnapshot: input.permissionSnapshot,
      reapproveOnWake: input.reapproveOnWake,
      concurrencyClass: input.concurrencyClass,
      ...(input.resourceBudget ? { resourceBudget: input.resourceBudget } : {}),
      attempt: 0,
      maxAttempts: input.maxAttempts,
      ...(input.contentHash ? { contentHash: input.contentHash } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
    })
    await this.store.saveTransition(queued, auditEvent(queued, 'enqueue', 'queued', now))
    this.tasks.set(taskKey(queued.projectId, queued.taskId), queued)
    this.notify(queued)
    return this.transition(
      {
        ...queued,
        processHandleId: processHandle,
        attempt: 1,
        startedAt: now,
      },
      'running',
      'start',
    )
  }

  async completeExternal(
    projectId: string,
    taskId: string,
    resultRef?: TaskResultRef,
  ): Promise<SupervisedTaskMeta | null> {
    const task = this.tasks.get(taskKey(projectId, taskId))
    if (!task || task.state !== 'running') return task ?? null
    return this.transition(
      {
        ...task,
        ...(resultRef ? { resultRef } : {}),
      },
      'completed',
      'complete',
    )
  }

  async failExternal(
    projectId: string,
    taskId: string,
    reason: string,
  ): Promise<SupervisedTaskMeta | null> {
    const task = this.tasks.get(taskKey(projectId, taskId))
    if (!task || task.state !== 'running') return task ?? null
    return this.transition(task, 'failed', 'fail', reason)
  }

  get(projectId: string, taskId: string): SupervisedTaskMeta | null {
    return this.tasks.get(taskKey(projectId, taskId)) ?? null
  }

  list(projectId?: string): SupervisedTaskMeta[] {
    return [...this.tasks.values()]
      .filter((task) => projectId === undefined || task.projectId === projectId)
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  async cancel(projectId: string, taskId: string): Promise<SupervisedTaskMeta | null> {
    const key = taskKey(projectId, taskId)
    const task = this.tasks.get(key)
    if (!task) return null
    if (isTerminalTaskState(task.state)) return task
    this.clearTimer(key)
    this.removeEventWaiter(key, task)
    this.pending.delete(key)
    this.abortControllers.get(key)?.abort()
    const externalCanceller = this.externalCancellers.get(task.handler)
    if (externalCanceller) {
      try {
        await externalCanceller(task)
      } catch (error) {
        this.onError(error)
      }
    }
    const current = this.tasks.get(key)
    if (!current || isTerminalTaskState(current.state)) return current ?? null
    return this.transition(current, 'cancelled', 'cancel', 'cancel requested')
  }

  async acknowledgeBlock(projectId: string, taskId: string): Promise<SupervisedTaskMeta | null> {
    const task = this.tasks.get(taskKey(projectId, taskId))
    if (!task) return null
    if (task.state !== 'blocked') return task
    const now = this.clock.now()
    const toState: TaskState =
      task.trigger.kind === 'cron' || (task.trigger.kind === 'wake_at' && task.trigger.wakeAt > now)
        ? 'waiting'
        : 'queued'
    const cleared = withoutLastError(task)
    const next = await this.transition(cleared, toState, 'unblock', 'block acknowledged')
    this.arm(next)
    return next
  }

  async waitForIdle(): Promise<void> {
    await Promise.resolve()
    await Promise.allSettled([...this.active.values()])
  }

  async shutdown(): Promise<void> {
    this.stopping = true
    this.pending.clear()
    this.eventWaiters.clear()
    for (const source of this.eventSources.values()) source.dispose()
    this.eventSources.clear()
    this.listeners.clear()
    for (const [key] of this.timers) this.clearTimer(key)
    for (const controller of this.abortControllers.values()) controller.abort()
    if (this.startPromise) await this.startPromise
    await this.waitForIdle()
  }

  private async startInternal(): Promise<void> {
    await this.store.compactTerminalTasks(this.clock.now() - this.terminalRetentionMs)
    const loaded = await this.store.loadAll()
    for (const diagnostic of loaded.diagnostics) this.onDiagnostic(diagnostic)
    for (const task of loaded.tasks) this.tasks.set(taskKey(task.projectId, task.taskId), task)
    const reconciled = reconcileSupervisedTasks({
      tasks: loaded.tasks,
      now: this.clock.now(),
    })
    for (const patch of reconciled.patches) {
      await this.store.saveTransition(patch.next, patch.audit)
      this.tasks.set(taskKey(patch.next.projectId, patch.taskId), patch.next)
      this.notify(patch.next)
    }
    const eligibleTaskIds = new Set(reconciled.eligibleWakeTaskIds)
    for (const task of this.tasks.values()) {
      if (eligibleTaskIds.has(task.taskId)) this.arm(task)
    }
    for (const task of this.tasks.values()) {
      if (
        task.state === 'waiting' &&
        task.trigger.kind === 'wake_at' &&
        task.trigger.wakeAt > this.clock.now()
      ) {
        this.arm(task)
      }
      if (task.state === 'waiting' && task.trigger.kind === 'event') this.arm(task)
      if (task.state === 'waiting' && task.trigger.kind === 'cron' && this.cronEnabled()) {
        this.arm(task)
      }
    }
  }

  private arm(task: SupervisedTaskMeta): void {
    if (this.stopping || isTerminalTaskState(task.state) || task.state === 'blocked') return
    const key = taskKey(task.projectId, task.taskId)
    this.clearTimer(key)
    this.removeEventWaiter(key, task)
    if (task.trigger.kind === 'event') {
      let waiters = this.eventWaiters.get(task.trigger.event)
      if (!waiters) {
        waiters = new Set()
        this.eventWaiters.set(task.trigger.event, waiters)
      }
      waiters.add(key)
      return
    }
    if (task.trigger.kind === 'cron') {
      if (!this.cronEnabled()) return
      const wakeAt = nextCronOccurrence(task.trigger.expression, this.clock.now())
      this.scheduleAt(key, wakeAt, () => {
        if (this.cronEnabled()) this.enqueueReady(key)
      })
      return
    }
    if (task.trigger.kind === 'wake_at' && task.trigger.wakeAt > this.clock.now()) {
      this.scheduleAt(key, task.trigger.wakeAt, () => {
        this.enqueueReady(key)
      })
      return
    }
    if (task.trigger.kind !== 'immediate') return
    queueMicrotask(() => {
      this.enqueueReady(key)
    })
  }

  private enqueueReady(key: string): void {
    if (this.stopping) return
    this.pending.add(key)
    this.drainReady()
  }

  private drainReady(): void {
    while (!this.stopping && this.active.size < this.maxConcurrent) {
      const key = [...this.pending].find((candidate) => this.hasClassCapacity(candidate))
      if (!key) return
      this.pending.delete(key)
      this.launch(key)
    }
  }

  private hasClassCapacity(key: string): boolean {
    const task = this.tasks.get(key)
    if (!task) return true
    const limit = this.concurrencyClassLimits[task.concurrencyClass] ?? this.maxConcurrent
    let activeInClass = 0
    for (const activeKey of this.active.keys()) {
      if (this.tasks.get(activeKey)?.concurrencyClass === task.concurrencyClass) activeInClass++
    }
    return activeInClass < limit
  }

  private launch(key: string): void {
    void this.execute(key).catch(this.onError)
  }

  private execute(key: string): Promise<void> {
    const existing = this.active.get(key)
    if (existing) return existing
    const running = this.executeInternal(key).finally(() => {
      if (this.active.get(key) === running) this.active.delete(key)
      this.abortControllers.delete(key)
      this.drainReady()
    })
    this.active.set(key, running)
    return running
  }

  private async executeInternal(key: string): Promise<void> {
    const task = this.tasks.get(key)
    if (
      !task ||
      this.stopping ||
      isTerminalTaskState(task.state) ||
      task.state === 'blocked' ||
      task.state === 'running'
    ) {
      return
    }
    const handler = this.handlers.get(task.handler)
    if (!handler) {
      await this.transition(
        task,
        'blocked',
        'block',
        `No supervised task handler is registered for "${task.handler}"`,
      )
      return
    }
    if (task.attempt >= task.maxAttempts) {
      await this.transition(task, 'failed', 'fail', 'maximum attempts exhausted')
      return
    }
    const controller = new AbortController()
    this.abortControllers.set(key, controller)
    const now = this.clock.now()
    const started = await this.transition(
      {
        ...withoutLastError(task),
        attempt: task.attempt + 1,
        startedAt: task.startedAt ?? now,
      },
      'running',
      task.state === 'waiting' ? 'wake' : 'start',
    )
    try {
      const result = await handler(started, { signal: controller.signal })
      const current = this.tasks.get(key)
      if (!current || current.state !== 'running' || controller.signal.aborted) return
      if (result.blockedReason) {
        await this.transition(current, 'blocked', 'block', result.blockedReason)
        return
      }
      if (current.trigger.kind === 'cron') {
        const waiting = await this.transition(
          {
            ...current,
            attempt: 0,
            ...(result.resultRef ? { resultRef: result.resultRef } : {}),
          },
          'waiting',
          'suspend',
          'waiting for next cron occurrence',
        )
        this.arm(waiting)
        return
      }
      await this.transition(
        {
          ...current,
          ...(result.resultRef ? { resultRef: result.resultRef } : {}),
        },
        'completed',
        'complete',
      )
    } catch (error) {
      const current = this.tasks.get(key)
      if (!current || current.state !== 'running' || controller.signal.aborted) return
      await this.transition(
        current,
        'failed',
        'fail',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  private async transition(
    task: SupervisedTaskMeta,
    toState: TaskState,
    action: SupervisedTaskAuditEvent['action'],
    reason?: string,
  ): Promise<SupervisedTaskMeta> {
    const now = this.clock.now()
    const terminal = isTerminalTaskState(toState)
    const next = supervisedTaskMetaSchema.parse({
      ...task,
      state: toState,
      updatedAt: now,
      ...(terminal ? { finishedAt: now } : {}),
      ...(reason && (toState === 'failed' || toState === 'blocked') ? { lastError: reason } : {}),
    })
    const key = taskKey(task.projectId, task.taskId)
    const previous = this.tasks.get(key)
    this.tasks.set(key, next)
    try {
      await this.store.saveTransition(next, auditEvent(task, action, toState, now, reason))
      this.notify(next)
    } catch (error) {
      if (this.tasks.get(key) === next) {
        if (previous) this.tasks.set(key, previous)
        else this.tasks.delete(key)
      }
      throw error
    }
    return next
  }

  private notify(task: SupervisedTaskMeta): void {
    for (const listener of this.listeners) {
      try {
        listener(task)
      } catch (error) {
        this.onError(error)
      }
    }
  }

  private clearTimer(key: string): void {
    const timer = this.timers.get(key)
    if (timer === undefined) return
    this.clock.clearTimeout(timer)
    this.timers.delete(key)
  }

  private scheduleAt(key: string, wakeAt: number, callback: () => void): void {
    const remaining = Math.max(0, wakeAt - this.clock.now())
    const handle = this.clock.setTimeout(
      () => {
        this.timers.delete(key)
        if (this.stopping) return
        if (this.clock.now() < wakeAt) {
          this.scheduleAt(key, wakeAt, callback)
          return
        }
        callback()
      },
      Math.min(remaining, MAX_TIMER_DELAY_MS),
    )
    this.timers.set(key, handle)
  }

  private removeEventWaiter(key: string, task: SupervisedTaskMeta): void {
    if (task.trigger.kind !== 'event') return
    const waiters = this.eventWaiters.get(task.trigger.event)
    waiters?.delete(key)
    if (waiters?.size === 0) this.eventWaiters.delete(task.trigger.event)
  }

  private releaseEventSource(
    sourceKey: string,
    registration: { references: number; dispose: () => void },
  ): void {
    if (this.eventSources.get(sourceKey) !== registration) return
    registration.references--
    if (registration.references > 0) return
    this.eventSources.delete(sourceKey)
    registration.dispose()
  }
}

let singleton: TaskSupervisor | null = null

export function getTaskSupervisor(): TaskSupervisor {
  singleton ??= new TaskSupervisor({
    cronEnabled: (): boolean => getDefaultPluginRegistry().isEnabled(AUTOMATIONS_PLUGIN_ID),
  })
  return singleton
}
