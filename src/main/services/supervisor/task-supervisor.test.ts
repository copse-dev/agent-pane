import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type {
  SupervisedTaskAuditEvent,
  SupervisedTaskMeta,
} from '@shared/supervisor/task-schema.ts'
import {
  TaskSupervisor,
  type EnqueueSupervisedTaskInput,
  type SupervisedTaskHandlerResult,
  type TaskSupervisorClock,
} from './task-supervisor.ts'
import type { LoadedSupervisedTasks, SupervisedTaskStore } from './task-store.ts'

function memoryKey(projectId: string, taskId: string): string {
  return `${projectId}\0${taskId}`
}

class MemoryTaskStore implements SupervisedTaskStore {
  readonly tasks = new Map<string, SupervisedTaskMeta>()
  readonly audit: SupervisedTaskAuditEvent[] = []
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

  saveTransition(meta: SupervisedTaskMeta, audit: SupervisedTaskAuditEvent): Promise<void> {
    this.tasks.set(memoryKey(meta.projectId, meta.taskId), meta)
    this.audit.push(audit)
    return Promise.resolve()
  }
}

class FakeClock implements TaskSupervisorClock {
  private value: number
  private nextId = 1
  private readonly timers = new Map<number, { at: number; callback: () => void }>()

  constructor(now: number) {
    this.value = now
  }

  now(): number {
    return this.value
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++
    this.timers.set(id, { at: this.value + delayMs, callback })
    return id
  }

  clearTimeout(handle: ReturnType<typeof setTimeout> | number): void {
    if (typeof handle === 'number') this.timers.delete(handle)
  }

  advanceBy(ms: number): void {
    this.value += ms
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.at <= this.value)
      .sort((left, right) => left[1].at - right[1].at)
    for (const [id, timer] of due) {
      this.timers.delete(id)
      timer.callback()
    }
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
