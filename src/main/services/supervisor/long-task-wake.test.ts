import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { asTurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import type {
  SupervisedTaskAuditEvent,
  SupervisedTaskArchive,
  SupervisedTaskMeta,
} from '@shared/supervisor/task-schema.ts'
import type { LongTask } from '../storage/long-task-tracker.ts'
import {
  installLongTaskWakeConsumer,
  scheduleLongTaskWake,
  type LongTaskWakeDependencies,
  type LongTaskWakeDispatcher,
} from './long-task-wake.ts'
import { TaskSupervisor, type TaskSupervisorClock } from './task-supervisor.ts'
import type { LoadedSupervisedTasks, SupervisedTaskStore } from './task-store.ts'

class MemoryStore implements SupervisedTaskStore {
  readonly tasks = new Map<string, SupervisedTaskMeta>()

  loadAll(): Promise<LoadedSupervisedTasks> {
    return Promise.resolve({ tasks: [...this.tasks.values()], diagnostics: [] })
  }

  loadProject(projectId: string): Promise<LoadedSupervisedTasks> {
    return Promise.resolve({
      tasks: [...this.tasks.values()].filter((task) => task.projectId === projectId),
      diagnostics: [],
    })
  }

  get(projectId: string, taskId: string): Promise<SupervisedTaskMeta | null> {
    const task = this.tasks.get(taskId)
    return Promise.resolve(task?.projectId === projectId ? task : null)
  }

  saveTransition(meta: SupervisedTaskMeta, _audit: SupervisedTaskAuditEvent): Promise<void> {
    this.tasks.set(meta.taskId, meta)
    return Promise.resolve()
  }

  compactTerminalTasks(): Promise<number> {
    return Promise.resolve(0)
  }

  loadTaskArchive(): Promise<SupervisedTaskArchive[]> {
    return Promise.resolve([])
  }
}

class FixedClock implements TaskSupervisorClock {
  private value: number
  private timer: { callback: () => void; delayMs: number } | null = null

  constructor(value: number) {
    this.value = value
  }

  now(): number {
    return this.value
  }

  setTimeout(callback: () => void, delayMs: number): number {
    this.timer = { callback, delayMs }
    return 1
  }

  clearTimeout(_handle: ReturnType<typeof setTimeout> | number): void {
    this.timer = null
  }

  fire(): void {
    const timer = this.timer
    this.timer = null
    if (!timer) return
    this.value += timer.delayMs
    timer.callback()
  }
}

const context = {
  projectId: 'project-1',
  threadId: 'thread-1',
  projectRoot: '/project',
  root: '/project',
  checkoutMode: 'shared' as const,
  branch: 'main',
}
const turnTreeId = asTurnTreeId('tree-1')

const longTask: LongTask = {
  id: 't1',
  title: 'Clear the backlog',
  goal: 'All checks pass',
  steps: [
    { id: 's1', label: 'Fix lint', done: false },
    { id: 's2', label: 'Run checks', done: false },
  ],
  createdAt: '2026-08-04T00:00:00.000Z',
  updatedAt: '2026-08-04T00:00:00.000Z',
}

function dependencies(overrides: Partial<LongTaskWakeDependencies> = {}): LongTaskWakeDependencies {
  return {
    isPluginEnabled: () => true,
    resolveContext: () => Promise.resolve(context),
    autoRunSandboxCommands: () => true,
    projectSandboxEnabled: () => true,
    workspaceTarget: () => ({ kind: 'local' }),
    loadTasks: () => [longTask],
    now: () => 100,
    abortThread: (): void => {},
    ...overrides,
  }
}

describe('long-task supervised wake', () => {
  it('deduplicates one pending wake and dispatches a bounded continuation', async () => {
    const store = new MemoryStore()
    const clock = new FixedClock(100)
    const supervisor = new TaskSupervisor({
      store,
      clock,
      createId: (): string => 'supervised-1',
    })
    const requests: Parameters<LongTaskWakeDispatcher['dispatchMachine']>[0][] = []
    const dispatcher: LongTaskWakeDispatcher = {
      dispatchMachine: (request): Promise<'completed'> => {
        requests.push(request)
        return Promise.resolve('completed')
      },
    }
    const dispose = installLongTaskWakeConsumer(supervisor, dispatcher, dependencies())

    try {
      const request = { context, turnTreeId, longTaskId: 't1', delayMs: 100 }
      const first = await scheduleLongTaskWake(request)
      const duplicate = await scheduleLongTaskWake(request)
      assert.equal(duplicate.taskId, first.taskId)
      assert.equal(store.tasks.get(first.taskId)?.reapproveOnWake, false)
      clock.fire()
      await supervisor.waitForIdle()

      assert.equal(requests.length, 1)
      const dispatched = requests[0]
      assert.ok(dispatched)
      assert.equal(dispatched.operationId, 'supervised-1')
      const prompt = dispatched.payload.userContent
      if (typeof prompt !== 'string') assert.fail('expected a text continuation prompt')
      assert.match(prompt, /Clear the backlog/)
      assert.match(prompt, /exactly one next wake/)
      assert.equal(store.tasks.get(first.taskId)?.state, 'completed')
    } finally {
      dispose()
      await supervisor.shutdown()
    }
  })

  it('does not dispatch when the plugin is disabled at wake time', async () => {
    const store = new MemoryStore()
    const clock = new FixedClock(100)
    const supervisor = new TaskSupervisor({
      store,
      clock,
      createId: (): string => 'supervised-disabled',
    })
    let dispatched = false
    const dispose = installLongTaskWakeConsumer(
      supervisor,
      {
        dispatchMachine: (): Promise<'completed'> => {
          dispatched = true
          return Promise.resolve('completed')
        },
      },
      dependencies({ isPluginEnabled: () => false }),
    )

    try {
      const scheduled = await scheduleLongTaskWake({
        context,
        turnTreeId,
        longTaskId: 't1',
        delayMs: 100,
      })
      clock.fire()
      await supervisor.waitForIdle()

      assert.equal(dispatched, false)
      assert.equal(store.tasks.get(scheduled.taskId)?.resultRef?.ref, 'plugin-disabled')
    } finally {
      dispose()
      await supervisor.shutdown()
    }
  })

  it('allows a running continuation to schedule exactly one successor', async () => {
    const store = new MemoryStore()
    const clock = new FixedClock(100)
    const supervisor = new TaskSupervisor({
      store,
      clock,
      createId: (() => {
        let id = 0
        return (): string => `supervised-${String(++id)}`
      })(),
    })
    const dispose = installLongTaskWakeConsumer(
      supervisor,
      {
        dispatchMachine: async (): Promise<'completed'> => {
          await scheduleLongTaskWake({ context, turnTreeId, longTaskId: 't1', delayMs: 100 })
          return 'completed'
        },
      },
      dependencies({ now: () => clock.now() }),
    )

    try {
      await scheduleLongTaskWake({ context, turnTreeId, longTaskId: 't1', delayMs: 100 })
      clock.fire()
      await supervisor.waitForIdle()

      assert.deepEqual(
        supervisor.list(context.projectId).map((task) => task.state),
        ['completed', 'waiting'],
      )
    } finally {
      dispose()
      await supervisor.shutdown()
    }
  })

  it('blocks instead of inheriting changed permission context', async () => {
    const store = new MemoryStore()
    const clock = new FixedClock(100)
    const supervisor = new TaskSupervisor({
      store,
      clock,
      createId: (): string => 'supervised-blocked',
    })
    let autoRun = true
    let dispatched = false
    const dispose = installLongTaskWakeConsumer(
      supervisor,
      {
        dispatchMachine: (): Promise<'completed'> => {
          dispatched = true
          return Promise.resolve('completed')
        },
      },
      dependencies({ autoRunSandboxCommands: () => autoRun }),
    )

    try {
      const scheduled = await scheduleLongTaskWake({
        context,
        turnTreeId,
        longTaskId: 't1',
        delayMs: 100,
      })
      autoRun = false
      clock.fire()
      await supervisor.waitForIdle()

      assert.equal(dispatched, false)
      assert.equal(store.tasks.get(scheduled.taskId)?.state, 'blocked')
      assert.match(store.tasks.get(scheduled.taskId)?.lastError ?? '', /permissions/)
    } finally {
      dispose()
      await supervisor.shutdown()
    }
  })

  it('blocks when the SSH host identity changes after scheduling', async () => {
    const store = new MemoryStore()
    const clock = new FixedClock(100)
    const supervisor = new TaskSupervisor({
      store,
      clock,
      createId: (): string => 'supervised-target-blocked',
    })
    let targetId = 'host-a'
    let dispatched = false
    const dispose = installLongTaskWakeConsumer(
      supervisor,
      {
        dispatchMachine: (): Promise<'completed'> => {
          dispatched = true
          return Promise.resolve('completed')
        },
      },
      dependencies({
        workspaceTarget: () => ({ kind: 'ssh', id: targetId }),
      }),
    )

    try {
      const scheduled = await scheduleLongTaskWake({
        context,
        turnTreeId,
        longTaskId: 't1',
        delayMs: 100,
      })
      assert.equal(store.tasks.get(scheduled.taskId)?.permissionSnapshot.workspaceTargetKind, 'ssh')
      assert.equal(
        store.tasks.get(scheduled.taskId)?.permissionSnapshot.workspaceTargetId,
        'host-a',
      )
      targetId = 'host-b'
      clock.fire()
      await supervisor.waitForIdle()

      assert.equal(dispatched, false)
      assert.equal(store.tasks.get(scheduled.taskId)?.state, 'blocked')
      assert.match(store.tasks.get(scheduled.taskId)?.lastError ?? '', /workspace changed/)
    } finally {
      dispose()
      await supervisor.shutdown()
    }
  })

  it('aborts an in-flight machine dispatch when the supervised task is cancelled', async () => {
    const store = new MemoryStore()
    const clock = new FixedClock(100)
    const supervisor = new TaskSupervisor({
      store,
      clock,
      createId: (): string => 'supervised-cancel',
    })
    let release!: (result: 'completed') => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const dispose = installLongTaskWakeConsumer(
      supervisor,
      {
        dispatchMachine: (): Promise<'completed'> =>
          new Promise((resolve) => {
            release = resolve
            entered()
          }),
      },
      dependencies({
        abortThread: () => {
          release('completed')
        },
      }),
    )

    try {
      const scheduled = await scheduleLongTaskWake({
        context,
        turnTreeId,
        longTaskId: 't1',
        delayMs: 100,
      })
      clock.fire()
      await started
      await supervisor.cancel(context.projectId, scheduled.taskId)
      await supervisor.waitForIdle()

      assert.equal(store.tasks.get(scheduled.taskId)?.state, 'cancelled')
    } finally {
      dispose()
      await supervisor.shutdown()
    }
  })
})
