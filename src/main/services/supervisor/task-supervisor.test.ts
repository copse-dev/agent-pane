import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type {
  SupervisedTaskAuditEvent,
  SupervisedTaskArchive,
  SupervisedTaskMeta,
} from '@shared/supervisor/task-schema.ts'
import {
  TaskSupervisor,
  type EnqueueSupervisedTaskInput,
  type SupervisedTaskHandlerResult,
  type TaskSupervisorClock,
} from './task-supervisor.ts'
import type { LoadedSupervisedTasks, SupervisedTaskStore } from './task-store.ts'
import { createSupervisedTaskClient } from './task-client.ts'

function memoryKey(projectId: string, taskId: string): string {
  return `${projectId}\0${taskId}`
}

class MemoryTaskStore implements SupervisedTaskStore {
  readonly tasks = new Map<string, SupervisedTaskMeta>()
  readonly audit: SupervisedTaskAuditEvent[] = []
  readonly archived: SupervisedTaskArchive[] = []
  readonly diagnostics: LoadedSupervisedTasks['diagnostics']

  constructor(
    initial: readonly SupervisedTaskMeta[] = [],
    diagnostics: LoadedSupervisedTasks['diagnostics'] = [],
  ) {
    for (const task of initial) this.tasks.set(memoryKey(task.projectId, task.taskId), task)
    this.diagnostics = diagnostics
  }

  loadAll(): Promise<LoadedSupervisedTasks> {
    return Promise.resolve({
      tasks: [...this.tasks.values()],
      diagnostics: this.diagnostics,
    })
  }

  loadProject(projectId: string): Promise<LoadedSupervisedTasks> {
    return Promise.resolve({
      tasks: [...this.tasks.values()].filter((task) => task.projectId === projectId),
      diagnostics: [],
    })
  }

  get(projectId: string, taskId: string): Promise<SupervisedTaskMeta | null> {
    return Promise.resolve(this.tasks.get(memoryKey(projectId, taskId)) ?? null)
  }

  async findPersisted(
    projectId: string,
    taskId: string,
  ): Promise<SupervisedTaskMeta | SupervisedTaskArchive | null> {
    return (
      (await this.get(projectId, taskId)) ??
      (await this.loadTaskArchive(projectId)).find((task) => task.taskId === taskId) ??
      null
    )
  }

  saveTransition(meta: SupervisedTaskMeta, audit: SupervisedTaskAuditEvent): Promise<void> {
    this.tasks.set(memoryKey(meta.projectId, meta.taskId), meta)
    this.audit.push(audit)
    return Promise.resolve()
  }

  compactTerminalTasks(before: number): Promise<number> {
    let compacted = 0
    for (const [key, task] of this.tasks) {
      if (
        task.updatedAt >= before ||
        (task.state !== 'cancelled' && task.state !== 'failed' && task.state !== 'completed')
      ) {
        continue
      }
      this.tasks.delete(key)
      this.archived.push({
        v: 1,
        taskId: task.taskId,
        projectId: task.projectId,
        threadId: task.threadId,
        handler: task.handler,
        provenance: task.provenance,
        state: task.state,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        attempt: task.attempt,
        ...(task.contentHash ? { contentHash: task.contentHash } : {}),
      })
      compacted++
    }
    return Promise.resolve(compacted)
  }

  loadTaskArchive(projectId: string): Promise<SupervisedTaskArchive[]> {
    return Promise.resolve(this.archived.filter((task) => task.projectId === projectId))
  }
}

class FakeClock implements TaskSupervisorClock {
  readonly scheduledDelays: number[] = []
  private value: number
  private elapsed = 0
  private nextId = 1
  private readonly timers = new Map<number, { at: number; callback: () => void }>()

  constructor(now: number) {
    this.value = now
  }

  now(): number {
    return this.value
  }

  setTimeout(callback: () => void, delayMs: number): number {
    this.scheduledDelays.push(delayMs)
    const id = this.nextId++
    this.timers.set(id, { at: this.elapsed + delayMs, callback })
    return id
  }

  clearTimeout(handle: ReturnType<typeof setTimeout> | number): void {
    if (typeof handle === 'number') this.timers.delete(handle)
  }

  advanceBy(ms: number): void {
    this.value += ms
    this.elapsed += ms
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.at <= this.elapsed)
      .sort((left, right) => left[1].at - right[1].at)
    for (const [id, timer] of due) {
      this.timers.delete(id)
      timer.callback()
    }
  }

  shiftWallBy(ms: number): void {
    this.value += ms
  }
}

function input(
  trigger: EnqueueSupervisedTaskInput['trigger'] = { kind: 'immediate' },
): EnqueueSupervisedTaskInput {
  return {
    projectId: 'project-1',
    threadId: 'thread-1',
    handler: 'test',
    provenance: 'agent' as const,
    trigger,
    permissionSnapshot: {
      capturedAt: 1,
      autoRunSandboxCommands: true,
      projectSandboxEnabled: true,
    },
    reapproveOnWake: false,
    concurrencyClass: 'test',
    maxAttempts: 2,
  }
}

function persistedTask(overrides: Partial<SupervisedTaskMeta> = {}): SupervisedTaskMeta {
  return {
    taskId: 'persisted-task',
    projectId: 'project-1',
    threadId: 'thread-1',
    handler: 'test',
    provenance: 'agent',
    state: 'queued',
    createdAt: 1,
    updatedAt: 1,
    trigger: { kind: 'immediate' },
    permissionSnapshot: {
      capturedAt: 1,
      autoRunSandboxCommands: true,
      projectSandboxEnabled: true,
    },
    reapproveOnWake: false,
    concurrencyClass: 'test',
    attempt: 0,
    maxAttempts: 2,
    ...overrides,
  }
}

describe('TaskSupervisor', () => {
  it('runs overdue one-shot wakes on admission and restart, exactly once', async () => {
    const store = new MemoryTaskStore([
      persistedTask({ state: 'waiting', trigger: { kind: 'wake_at', wakeAt: 10 } }),
    ])
    const supervisor = new TaskSupervisor({ store, clock: new FakeClock(100) })
    let runs = 0
    supervisor.registerHandler('test', async () => {
      runs++
      return {}
    })
    await supervisor.start()
    await supervisor.enqueue(input({ kind: 'wake_at', wakeAt: 100 }))
    await supervisor.waitForIdle()
    assert.equal(runs, 2)
    await supervisor.wake('project-1', 'persisted-task')
    await supervisor.waitForIdle()
    assert.equal(runs, 2)
  })

  it('keeps ownership isolated for every client operation and returned record', async () => {
    const supervisor = new TaskSupervisor({
      store: new MemoryTaskStore(),
      clock: new FakeClock(100),
    })
    const task = await supervisor.enqueue(input({ kind: 'event', event: 'ready' }))
    const owner = { projectId: task.projectId, threadId: task.threadId }
    const client = createSupervisedTaskClient(supervisor, owner)
    for (const foreignOwner of [
      { ...owner, projectId: 'project-2' },
      { ...owner, threadId: 'thread-2' },
    ]) {
      const foreign = createSupervisedTaskClient(supervisor, foreignOwner)
      assert.deepEqual(await foreign.list(), { tasks: [] })
      assert.deepEqual(await foreign.get(task.taskId), { task: null })
      assert.deepEqual(await foreign.cancel(task.taskId), { task: null })
      assert.deepEqual(await foreign.resume(task.taskId), { task: null })
    }
    task.threadId = 'thread-2'
    const exposed = supervisor.get(task.projectId, task.taskId)
    assert.ok(exposed)
    exposed.threadId = 'thread-2'
    owner.threadId = 'thread-2'
    const inspected = (await client.get(task.taskId)).task
    assert.equal(inspected?.threadId, 'thread-1')
    assert.ok(!Object.hasOwn(inspected, 'permissionSnapshot'))
    assert.equal((await client.cancel(task.taskId)).task?.state, 'cancelled')
    assert.equal((await client.resume(task.taskId)).task?.state, 'cancelled')
  })

  it('persists bounded exponential retries without losing the event trigger', async () => {
    const store = new MemoryTaskStore()
    const clock = new FakeClock(100)
    const first = new TaskSupervisor({ store, clock })
    first.registerHandler('test', async () => {
      throw new Error('temporary failure')
    })
    const task = await first.enqueue({
      ...input({ kind: 'event', event: 'ready' }),
      maxAttempts: 3,
      retryPolicy: { initialDelayMs: 100, maxDelayMs: 150 },
    })
    assert.deepEqual(
      await Promise.all([first.emitEvent('ready'), first.emitEvent('ready')]),
      [1, 0],
    )
    await first.waitForIdle()
    assert.equal(first.get(task.projectId, task.taskId)?.retryAt, 200)
    await first.shutdown()
    const second = new TaskSupervisor({ store, clock })
    let attempts = 0
    second.registerHandler('test', async () => {
      attempts++
      throw new Error('still failing')
    })
    await second.start()
    clock.advanceBy(99)
    await second.waitForIdle()
    assert.equal(attempts, 0)
    clock.advanceBy(1)
    await second.waitForIdle()
    assert.equal(second.get(task.projectId, task.taskId)?.retryAt, 350)
    assert.deepEqual(second.get(task.projectId, task.taskId)?.trigger, {
      kind: 'event',
      event: 'ready',
    })
    clock.advanceBy(150)
    await second.waitForIdle()
    assert.equal(attempts, 2)
    assert.equal(second.get(task.projectId, task.taskId)?.state, 'failed')
    clock.advanceBy(10_000)
    await second.waitForIdle()
    assert.equal(attempts, 2)
  })

  it('coalesces missed cron occurrences after restart and does not repeat them after clock rollback', async () => {
    const clock = new FakeClock(new Date(2026, 0, 1, 0, 0, 0).getTime())
    const store = new MemoryTaskStore()
    const first = new TaskSupervisor({ store, clock, cronEnabled: (): boolean => true })
    const task = await first.enqueue(input({ kind: 'cron', expression: '* * * * *' }))
    const firstDeadline = first.get(task.projectId, task.taskId)?.nextWakeAt
    assert.ok(firstDeadline)
    await first.shutdown()
    clock.advanceBy(5 * 60_000)
    const second = new TaskSupervisor({ store, clock, cronEnabled: (): boolean => true })
    let runs = 0
    second.registerHandler('test', async () => {
      runs++
      return {}
    })
    await second.start()
    clock.advanceBy(0)
    await second.waitForIdle()
    assert.equal(runs, 1)
    const next = second.get(task.projectId, task.taskId)?.nextWakeAt
    assert.ok(next && next > clock.now())
    clock.shiftWallBy(-3 * 60_000)
    clock.advanceBy(60_000)
    await second.waitForIdle()
    assert.equal(runs, 1)
    clock.advanceBy(3 * 60_000)
    await second.waitForIdle()
    assert.equal(runs, 2)
  })

  it('detects a forward wall-clock jump within one minute without early backward-clock wakes', async () => {
    const clock = new FakeClock(1_000)
    const supervisor = new TaskSupervisor({ store: new MemoryTaskStore(), clock })
    let runs = 0
    supervisor.registerHandler('test', async () => {
      runs++
      return {}
    })
    await supervisor.enqueue(input({ kind: 'wake_at', wakeAt: 3_601_000 }))
    clock.shiftWallBy(-60_000)
    clock.advanceBy(60_000)
    await supervisor.waitForIdle()
    assert.equal(runs, 0)
    clock.shiftWallBy(4_000_000)
    clock.advanceBy(60_000)
    await supervisor.waitForIdle()
    assert.equal(runs, 1)
  })

  it('holds crash-interrupted execution unless recovery is explicitly idempotent', async () => {
    const original = persistedTask({ state: 'running', attempt: 1 })
    const supervisor = new TaskSupervisor({
      store: new MemoryTaskStore([original]),
      clock: new FakeClock(100),
    })
    let runs = 0
    supervisor.registerHandler('test', async () => {
      runs++
      return {}
    })
    const client = createSupervisedTaskClient(supervisor, original)
    assert.equal((await client.get(original.taskId)).task?.state, 'blocked')
    assert.equal(runs, 0)
    await client.resume(original.taskId)
    await supervisor.waitForIdle()
    assert.equal(runs, 1)
    assert.equal((await client.get(original.taskId)).task?.state, 'completed')
  })

  it('requires a fresh explicit resume for each approval-scoped cron occurrence', async () => {
    const clock = new FakeClock(new Date(2026, 0, 1, 0, 0, 0).getTime())
    const supervisor = new TaskSupervisor({
      store: new MemoryTaskStore(),
      clock,
      cronEnabled: (): boolean => true,
    })
    let runs = 0
    supervisor.registerHandler('test', async (task) => {
      assert.equal(task.reapproveOnWake, false)
      runs++
      return {}
    })
    const task = await supervisor.enqueue({
      ...input({ kind: 'cron', expression: '* * * * *' }),
      reapproveOnWake: true,
    })
    clock.advanceBy(60_000)
    await supervisor.waitForIdle()
    assert.equal(supervisor.get(task.projectId, task.taskId)?.state, 'blocked')
    assert.equal(runs, 0)
    const client = createSupervisedTaskClient(supervisor, task)
    await client.resume(task.taskId)
    await supervisor.waitForIdle()
    assert.equal(runs, 1)
    clock.advanceBy(60_000)
    await supervisor.waitForIdle()
    assert.equal(supervisor.get(task.projectId, task.taskId)?.state, 'blocked')
    assert.equal(runs, 1)
  })

  it('never refreshes an expired snapshot through resume', async () => {
    const supervisor = new TaskSupervisor({
      store: new MemoryTaskStore(),
      clock: new FakeClock(100),
    })
    supervisor.registerHandler('test', async () => {
      assert.fail('expired permission')
    })
    const task = await supervisor.enqueue({
      ...input(),
      permissionSnapshot: { ...input().permissionSnapshot, expiresAt: 99 },
    })
    await supervisor.waitForIdle()
    await createSupervisedTaskClient(supervisor, task).resume(task.taskId)
    await supervisor.waitForIdle()
    assert.match(supervisor.get(task.projectId, task.taskId)?.lastError ?? '', /expired/)
    assert.equal(supervisor.get(task.projectId, task.taskId)?.state, 'blocked')
  })

  it('cancels before invoking a handler when cancellation wins the start-write race', async () => {
    let release!: () => void
    let started!: () => void
    const starting = new Promise<void>((resolve) => {
      started = resolve
    })
    class SlowStartStore extends MemoryTaskStore {
      override async saveTransition(
        task: SupervisedTaskMeta,
        audit: SupervisedTaskAuditEvent,
      ): Promise<void> {
        await super.saveTransition(task, audit)
        if (audit.action === 'start') {
          started()
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
      }
    }
    const supervisor = new TaskSupervisor({
      store: new SlowStartStore(),
      clock: new FakeClock(100),
    })
    let runs = 0
    supervisor.registerHandler('test', async () => {
      runs++
      return {}
    })
    const task = await supervisor.enqueue(input())
    await starting
    await supervisor.cancel(task.projectId, task.taskId)
    release()
    await supervisor.waitForIdle()
    assert.equal(runs, 0)
    assert.equal(supervisor.get(task.projectId, task.taskId)?.state, 'cancelled')
  })

  it('fences external completion that races a cancellation', async () => {
    const supervisor = new TaskSupervisor({
      store: new MemoryTaskStore(),
      clock: new FakeClock(100),
    })
    supervisor.registerExternalCanceller('shell_process', async (task) => {
      await supervisor.completeExternal(task.projectId, task.taskId)
    })
    const task = await supervisor.adoptRunning(
      { ...input(), handler: 'shell_process' },
      'process-1',
    )
    await supervisor.cancel(task.projectId, task.taskId)
    assert.equal(supervisor.get(task.projectId, task.taskId)?.state, 'cancelled')
  })

  it('enforces duration and cancellation grace even for a handler that ignores abort', async () => {
    const clock = new FakeClock(100)
    const supervisor = new TaskSupervisor({
      store: new MemoryTaskStore(),
      clock,
      cancellationGraceMs: 10,
      maxConcurrent: 1,
    })
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: (result: SupervisedTaskHandlerResult) => void
    supervisor.registerHandler('test', () => {
      entered()
      return new Promise<SupervisedTaskHandlerResult>((resolve) => {
        release = resolve
      })
    })
    const task = await supervisor.enqueue({ ...input(), resourceBudget: { maxDurationMs: 50 } })
    await enteredPromise
    clock.advanceBy(50)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(supervisor.get(task.projectId, task.taskId)?.state, 'failed')
    clock.advanceBy(10)
    await supervisor.waitForIdle()
    await assert.rejects(
      createSupervisedTaskClient(supervisor, task).resume(task.taskId),
      /has not stopped/,
    )
    release({ resultRef: { kind: 'handler', ref: 'late' } })
    await supervisor.waitForIdle()
    assert.equal(supervisor.get(task.projectId, task.taskId)?.state, 'failed')
    assert.equal(supervisor.get(task.projectId, task.taskId)?.resultRef, undefined)
  })

  it('bounds shutdown, persists the recovery state, and refuses work after shutdown', async () => {
    const clock = new FakeClock(100)
    const store = new MemoryTaskStore()
    const supervisor = new TaskSupervisor({ store, clock, cancellationGraceMs: 10 })
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    supervisor.registerHandler('test', () => {
      entered()
      return new Promise<SupervisedTaskHandlerResult>(() => {})
    })
    const task = await supervisor.enqueue(input())
    await started
    const stopping = supervisor.shutdown()
    await new Promise<void>((resolve) => setImmediate(resolve))
    clock.advanceBy(10)
    await stopping
    assert.equal(supervisor.get(task.projectId, task.taskId)?.state, 'blocked')
    await assert.rejects(supervisor.enqueue(input()), /stopping/)
    await assert.rejects(supervisor.adoptRunning(input(), 'new-process'), /stopping/)
    const restarted = new TaskSupervisor({ store, clock })
    restarted.registerHandler('test', async () => {
      assert.fail('Interrupted work must wait for inspection')
    })
    await restarted.start()
    await restarted.waitForIdle()
    assert.equal(restarted.get(task.projectId, task.taskId)?.state, 'blocked')
  })

  it('lets resource policy tighten automatic retries and records an explicit retry cycle', async () => {
    const clock = new FakeClock(100)
    const store = new MemoryTaskStore()
    const supervisor = new TaskSupervisor({ store, clock })
    let runs = 0
    supervisor.registerHandler('test', async () => {
      runs++
      if (runs === 1) throw new Error('temporary failure')
      return {}
    })
    const task = await supervisor.enqueue({
      ...input(),
      maxAttempts: 5,
      retryPolicy: { initialDelayMs: 100, maxDelayMs: 200 },
      resourceBudget: { maxAttempts: 1 },
    })
    await supervisor.waitForIdle()
    assert.equal(supervisor.get(task.projectId, task.taskId)?.state, 'failed')
    clock.advanceBy(1000)
    await supervisor.waitForIdle()
    assert.equal(runs, 1)
    await createSupervisedTaskClient(supervisor, task).resume(task.taskId)
    await supervisor.waitForIdle()
    assert.equal(runs, 2)
    assert.equal(supervisor.get(task.projectId, task.taskId)?.state, 'completed')
    assert.ok(store.audit.some((event) => event.action === 'retry' && event.fromState === 'failed'))
  })

  it('respects class capacity without starving an unrelated class', async () => {
    const supervisor = new TaskSupervisor({
      store: new MemoryTaskStore(),
      clock: new FakeClock(100),
      maxConcurrent: 2,
      concurrencyClassLimits: { poller: 1 },
    })
    const classes: string[] = []
    let release!: (result: SupervisedTaskHandlerResult) => void
    supervisor.registerHandler('test', (task) => {
      classes.push(task.concurrencyClass)
      if (classes.length === 1)
        return new Promise((resolve) => {
          release = resolve
        })
      return Promise.resolve({})
    })
    await supervisor.enqueue({ ...input(), concurrencyClass: 'poller' })
    await supervisor.enqueue({ ...input(), concurrencyClass: 'poller' })
    await supervisor.enqueue({ ...input(), concurrencyClass: 'toString' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(classes, ['poller', 'toString'])
    release({})
    await supervisor.waitForIdle()
    assert.deepEqual(classes, ['poller', 'toString', 'poller'])
  })

  it('persists every immediate-task transition before completing', async () => {
    const store = new MemoryTaskStore()
    const clock = new FakeClock(100)
    const supervisor = new TaskSupervisor({
      store,
      clock,
      createId: (): string => 'task-1',
    })
    supervisor.registerHandler('test', (): Promise<SupervisedTaskHandlerResult> =>
      Promise.resolve({ resultRef: { kind: 'handler', ref: 'result-1' } }),
    )

    const task = await supervisor.enqueue(input())
    await supervisor.waitForIdle()

    assert.equal(task.state, 'queued')
    assert.equal(supervisor.get(task.projectId, task.taskId)?.state, 'completed')
    assert.deepEqual(
      store.audit.map((event) => event.action),
      ['enqueue', 'start', 'complete'],
    )
    assert.equal(
      store.tasks.get(memoryKey(task.projectId, task.taskId))?.resultRef?.ref,
      'result-1',
    )
  })

  it('re-arms a future wake after restart and delivers it exactly once', async () => {
    const waiting = persistedTask({
      state: 'waiting',
      trigger: { kind: 'wake_at', wakeAt: 1_000 },
    })
    const store = new MemoryTaskStore([waiting])
    const clock = new FakeClock(500)
    const supervisor = new TaskSupervisor({ store, clock })
    let runs = 0
    supervisor.registerHandler('test', (): Promise<SupervisedTaskHandlerResult> => {
      runs++
      return Promise.resolve({})
    })

    await supervisor.start()
    clock.advanceBy(499)
    await supervisor.waitForIdle()
    assert.equal(runs, 0)

    clock.advanceBy(1)
    await supervisor.waitForIdle()
    clock.advanceBy(10_000)
    await supervisor.waitForIdle()

    assert.equal(runs, 1)
    assert.equal(supervisor.get(waiting.projectId, waiting.taskId)?.state, 'completed')
    assert.deepEqual(
      store.audit.map((event) => event.action),
      ['wake', 'complete'],
    )
  })

  it('persists handler input while rescheduling one task and supports an immediate reconcile wake', async () => {
    const store = new MemoryTaskStore()
    const clock = new FakeClock(100)
    const supervisor = new TaskSupervisor({
      store,
      clock,
      createId: (): string => 'task-1',
    })
    supervisor.registerHandler('test', (task): Promise<SupervisedTaskHandlerResult> => {
      const count = task.handlerInput?.['count']
      if (count === 0) {
        return Promise.resolve({
          reschedule: {
            trigger: { kind: 'wake_at', wakeAt: 1_000 },
            handlerInput: { count: 1 },
            reason: 'still waiting',
          },
        })
      }
      return Promise.resolve({ resultRef: { kind: 'handler', ref: 'done' } })
    })

    const task = await supervisor.enqueue({ ...input(), handlerInput: { count: 0 } })
    await supervisor.waitForIdle()

    assert.equal(supervisor.get(task.projectId, task.taskId)?.state, 'waiting')
    assert.deepEqual(supervisor.get(task.projectId, task.taskId)?.handlerInput, { count: 1 })
    assert.equal(await supervisor.wake(task.projectId, task.taskId, 'startup reconcile'), true)
    await supervisor.waitForIdle()

    assert.equal(supervisor.get(task.projectId, task.taskId)?.state, 'completed')
    assert.equal(await supervisor.wake(task.projectId, task.taskId), false)
    assert.deepEqual(
      store.audit.map((event) => event.action),
      ['enqueue', 'start', 'suspend', 'wake', 'start', 'complete'],
    )
  })

  it('persists event waiters and delivers each matching task exactly once', async () => {
    const waiting = persistedTask({
      state: 'waiting',
      trigger: { kind: 'event', event: 'ci:completed' },
    })
    const store = new MemoryTaskStore([waiting])
    const supervisor = new TaskSupervisor({ store, clock: new FakeClock(500) })
    let runs = 0
    supervisor.registerHandler('test', (): Promise<SupervisedTaskHandlerResult> => {
      runs++
      return Promise.resolve({})
    })

    await supervisor.start()
    assert.equal(await supervisor.emitEvent('ci:unrelated'), 0)
    assert.equal(runs, 0)

    assert.equal(await supervisor.emitEvent('ci:completed'), 1)
    await supervisor.waitForIdle()
    assert.equal(await supervisor.emitEvent('ci:completed'), 0)

    assert.equal(runs, 1)
    assert.equal(supervisor.get(waiting.projectId, waiting.taskId)?.state, 'completed')
    assert.deepEqual(
      store.audit.map((event) => event.action),
      ['wake', 'start', 'complete'],
    )
  })

  it('runs enabled cron tasks once per occurrence and rearms after success', async () => {
    const store = new MemoryTaskStore()
    const clock = new FakeClock(1_000)
    let cronEnabled = true
    const supervisor = new TaskSupervisor({
      store,
      clock,
      cronEnabled: (): boolean => cronEnabled,
    })
    let runs = 0
    supervisor.registerHandler('test', (): Promise<SupervisedTaskHandlerResult> => {
      runs++
      return Promise.resolve({})
    })

    const task = await supervisor.enqueue(input({ kind: 'cron', expression: '* * * * *' }))
    assert.equal(task.state, 'waiting')
    clock.advanceBy(59_000)
    await supervisor.waitForIdle()
    assert.equal(runs, 1)
    assert.equal(supervisor.get(task.projectId, task.taskId)?.state, 'waiting')

    cronEnabled = false
    supervisor.syncCronTasks()
    clock.advanceBy(60_000)
    await supervisor.waitForIdle()
    assert.equal(runs, 1)

    cronEnabled = true
    supervisor.syncCronTasks()
    clock.advanceBy(60_000)
    await supervisor.waitForIdle()
    assert.equal(runs, 2)
    assert.equal(supervisor.get(task.projectId, task.taskId)?.attempt, 0)
    assert.deepEqual(
      store.audit.map((entry) => entry.action),
      ['enqueue', 'wake', 'suspend', 'wake', 'suspend'],
    )
  })

  it('rejects cron tasks while the explicit feature gate is disabled', async () => {
    const supervisor = new TaskSupervisor({
      store: new MemoryTaskStore(),
      clock: new FakeClock(1_000),
    })
    await assert.rejects(
      supervisor.enqueue(input({ kind: 'cron', expression: '* * * * *' })),
      /disabled/,
    )
  })

  it('rearms a persisted cron task after restart', async () => {
    const waiting = persistedTask({
      state: 'waiting',
      trigger: { kind: 'cron', expression: '* * * * *' },
    })
    const clock = new FakeClock(1_000)
    const supervisor = new TaskSupervisor({
      store: new MemoryTaskStore([waiting]),
      clock,
      cronEnabled: (): boolean => true,
    })
    let runs = 0
    supervisor.registerHandler('test', (): Promise<SupervisedTaskHandlerResult> => {
      runs++
      return Promise.resolve({})
    })

    await supervisor.start()
    clock.advanceBy(59_000)
    await supervisor.waitForIdle()

    assert.equal(runs, 1)
    assert.equal(supervisor.get(waiting.projectId, waiting.taskId)?.state, 'waiting')
  })

  it('chunks cron waits longer than the platform timer limit', async () => {
    const clock = new FakeClock(new Date(2026, 0, 2, 0, 0, 0).getTime())
    const supervisor = new TaskSupervisor({
      store: new MemoryTaskStore(),
      clock,
      cronEnabled: (): boolean => true,
    })

    await supervisor.enqueue(input({ kind: 'cron', expression: '0 0 1 1 *' }))

    assert.equal(clock.scheduledDelays.length, 1)
    assert.ok((clock.scheduledDelays[0] ?? Infinity) <= 2_147_000_000)
  })

  it('compacts expired terminal tasks before restart reconciliation', async () => {
    const expired = persistedTask({
      taskId: 'expired',
      state: 'completed',
      updatedAt: 300,
      finishedAt: 300,
    })
    const recent = persistedTask({
      taskId: 'recent',
      state: 'failed',
      updatedAt: 950,
      finishedAt: 950,
    })
    const store = new MemoryTaskStore([expired, recent])
    const supervisor = new TaskSupervisor({
      store,
      clock: new FakeClock(1_000),
      terminalRetentionMs: 100,
    })

    await supervisor.start()

    assert.equal(supervisor.get(expired.projectId, expired.taskId), null)
    assert.equal(supervisor.get(recent.projectId, recent.taskId)?.state, 'failed')
    assert.deepEqual(
      store.archived.map((task) => task.taskId),
      ['expired'],
    )
  })

  it('reference-counts event sources so a fleet key starts one poller', async () => {
    const supervisor = new TaskSupervisor({
      store: new MemoryTaskStore(),
      clock: new FakeClock(500),
    })
    let starts = 0
    let stops = 0
    const start = (): (() => void) => {
      starts++
      return () => {
        stops++
      }
    }

    const releaseFirst = supervisor.registerEventSource('fleet:primary', start)
    const releaseSecond = supervisor.registerEventSource('fleet:primary', start)
    assert.equal(starts, 1)

    releaseFirst()
    releaseFirst()
    assert.equal(stops, 0)
    releaseSecond()
    assert.equal(stops, 1)
  })

  it('keeps identical task ids isolated by project ownership', async () => {
    const store = new MemoryTaskStore()
    const supervisor = new TaskSupervisor({
      store,
      clock: new FakeClock(100),
      createId: (): string => 'shared-id',
    })
    const first = await supervisor.enqueue(input({ kind: 'wake_at', wakeAt: 1_000 }))
    const second = await supervisor.enqueue({
      ...input({ kind: 'wake_at', wakeAt: 1_000 }),
      projectId: 'project-2',
    })

    await supervisor.cancel(first.projectId, first.taskId)

    assert.equal(supervisor.get(first.projectId, first.taskId)?.state, 'cancelled')
    assert.equal(supervisor.get(second.projectId, second.taskId)?.state, 'waiting')
    assert.deepEqual(
      supervisor.list('project-1').map((task) => task.projectId),
      ['project-1'],
    )
    assert.deepEqual(
      supervisor.list('project-2').map((task) => task.projectId),
      ['project-2'],
    )
  })

  it('bounds concurrent handler execution and drains ready tasks in order', async () => {
    const store = new MemoryTaskStore()
    let id = 0
    const supervisor = new TaskSupervisor({
      store,
      clock: new FakeClock(100),
      createId: (): string => `task-${String(++id)}`,
      maxConcurrent: 1,
    })
    const started: string[] = []
    const releases: Array<(result: SupervisedTaskHandlerResult) => void> = []
    supervisor.registerHandler('test', (task): Promise<SupervisedTaskHandlerResult> => {
      started.push(task.taskId)
      return new Promise((resolve) => {
        releases.push(resolve)
      })
    })

    await supervisor.enqueue(input())
    await supervisor.enqueue(input())
    await Promise.resolve()
    assert.deepEqual(started, ['task-1'])

    releases[0]?.({})
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
    assert.deepEqual(started, ['task-1', 'task-2'])

    releases[1]?.({})
    await supervisor.waitForIdle()
    assert.deepEqual(
      supervisor.list('project-1').map((task) => task.state),
      ['completed', 'completed'],
    )
  })

  it('fails a running shell task whose process handle was lost on restart', async () => {
    const running = persistedTask({
      handler: 'shell_process',
      state: 'running',
      processHandleId: 'dead-process',
      startedAt: 2,
    })
    const store = new MemoryTaskStore([running])
    const supervisor = new TaskSupervisor({ store, clock: new FakeClock(10) })

    await supervisor.start()

    const reconciled = supervisor.get(running.projectId, running.taskId)
    assert.ok(reconciled)
    assert.equal(reconciled.state, 'failed')
    assert.equal(reconciled.processHandleId, undefined)
    assert.equal(store.audit[0]?.action, 'fail')
  })

  it('blocks unknown handlers and can continue after acknowledgement', async () => {
    const store = new MemoryTaskStore()
    const supervisor = new TaskSupervisor({
      store,
      clock: new FakeClock(100),
      createId: (): string => 'task-unknown',
    })
    const task = await supervisor.enqueue({ ...input(), handler: 'later' })
    await supervisor.waitForIdle()
    assert.equal(supervisor.get(task.projectId, task.taskId)?.state, 'blocked')

    supervisor.registerHandler('later', (): Promise<SupervisedTaskHandlerResult> =>
      Promise.resolve({}),
    )
    await supervisor.acknowledgeBlock(task.projectId, task.taskId)
    await supervisor.waitForIdle()

    assert.equal(supervisor.get(task.projectId, task.taskId)?.state, 'completed')
    assert.deepEqual(
      store.audit.map((event) => event.action),
      ['enqueue', 'block', 'unblock', 'start', 'complete'],
    )
  })

  it('cancels an active handler without allowing late completion to overwrite it', async () => {
    const store = new MemoryTaskStore()
    const supervisor = new TaskSupervisor({
      store,
      clock: new FakeClock(100),
      createId: (): string => 'task-cancel',
    })
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    supervisor.registerHandler(
      'test',
      (_task, { signal }): Promise<never> =>
        new Promise<never>((_resolve, reject) => {
          entered()
          signal.addEventListener(
            'abort',
            () => {
              reject(new Error('aborted'))
            },
            { once: true },
          )
        }),
    )
    const task = await supervisor.enqueue(input())
    await started

    await supervisor.cancel(task.projectId, task.taskId)
    await supervisor.waitForIdle()

    assert.equal(supervisor.get(task.projectId, task.taskId)?.state, 'cancelled')
    assert.equal(store.audit.at(-1)?.action, 'cancel')
  })

  it('adopts and completes an externally managed running task', async () => {
    const store = new MemoryTaskStore()
    const supervisor = new TaskSupervisor({
      store,
      clock: new FakeClock(100),
      createId: (): string => 'external-task',
    })

    const task = await supervisor.adoptRunning(
      { ...input(), handler: 'shell_process', maxAttempts: 1 },
      'process-1',
    )
    assert.equal(task.state, 'running')
    assert.equal(task.processHandleId, 'process-1')

    await supervisor.completeExternal(task.projectId, task.taskId, {
      kind: 'handler',
      ref: 'process-1',
    })

    assert.equal(supervisor.get(task.projectId, task.taskId)?.state, 'completed')
    assert.deepEqual(
      store.audit.map((event) => event.action),
      ['enqueue', 'start', 'complete'],
    )
  })

  it('invokes the external canceller before cancelling an adopted task', async () => {
    const supervisor = new TaskSupervisor({
      store: new MemoryTaskStore(),
      clock: new FakeClock(100),
      createId: (): string => 'external-task',
    })
    let cancelledHandle: string | undefined
    supervisor.registerExternalCanceller('shell_process', (task) => {
      cancelledHandle = task.processHandleId
    })
    const task = await supervisor.adoptRunning(
      { ...input(), handler: 'shell_process', maxAttempts: 1 },
      'process-1',
    )

    await supervisor.cancel(task.projectId, task.taskId)

    assert.equal(cancelledHandle, 'process-1')
    assert.equal(supervisor.get(task.projectId, task.taskId)?.state, 'cancelled')
  })

  it('fails ready tasks whose attempt budget is exhausted without invoking the handler', async () => {
    const exhausted = persistedTask({ attempt: 2, maxAttempts: 2 })
    const store = new MemoryTaskStore([exhausted])
    const supervisor = new TaskSupervisor({ store, clock: new FakeClock(100) })
    let runs = 0
    supervisor.registerHandler('test', (): Promise<SupervisedTaskHandlerResult> => {
      runs++
      return Promise.resolve({})
    })

    await supervisor.start()
    await supervisor.waitForIdle()

    assert.equal(runs, 0)
    assert.equal(supervisor.get(exhausted.projectId, exhausted.taskId)?.state, 'failed')
    assert.match(supervisor.get(exhausted.projectId, exhausted.taskId)?.lastError ?? '', /attempts/)
  })
})
