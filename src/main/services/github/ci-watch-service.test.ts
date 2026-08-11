import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { asTurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import type {
  SupervisedTaskArchive,
  SupervisedTaskAuditEvent,
  SupervisedTaskMeta,
} from '@shared/supervisor/task-schema.ts'
import type { LoadedSupervisedTasks, SupervisedTaskStore } from '../supervisor/task-store.ts'
import { TaskSupervisor, type TaskSupervisorClock } from '../supervisor/task-supervisor.ts'
import type { CiStatus } from './github-ci-service.ts'
import {
  installCiWatchConsumer,
  scheduleCiWatch,
  type CiWatchDependencies,
  type CiWatchDispatcher,
} from './ci-watch-service.ts'

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
  branch: 'feature',
}
const turnTreeId = asTurnTreeId('tree-1')

function status(overall: CiStatus['overall'], headSha = 'head-1'): CiStatus {
  return {
    prNumber: 42,
    prTitle: 'Test durable CI watch',
    prUrl: 'https://github.com/example/repo/pull/42',
    branch: 'feature',
    headSha,
    overall,
    checks:
      overall === 'failure'
        ? [{ name: 'test', state: 'FAILURE', bucket: 'fail' }]
        : [{ name: 'test', state: 'IN_PROGRESS', bucket: 'pending' }],
    latestRunId: 100,
    latestRunUrl: 'https://github.com/example/repo/actions/runs/100',
  }
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function dependencies(
  clock: FixedClock,
  statuses: CiStatus[],
  overrides: Partial<CiWatchDependencies> = {},
): CiWatchDependencies {
  return {
    readStatus: (): Promise<CiStatus> => {
      const next = statuses.shift()
      if (!next) return Promise.reject(new Error('unexpected CI status read'))
      return Promise.resolve(next)
    },
    resolveContext: () => Promise.resolve(context),
    autoRunSandboxCommands: () => true,
    projectSandboxEnabled: () => true,
    workspaceTarget: () => ({ kind: 'local' }),
    now: () => clock.now(),
    abortThread: (): void => {},
    ...overrides,
  }
}

describe('durable CI watch', () => {
  it('reschedules while pending and dispatches one continuation when CI fails', async () => {
    const store = new MemoryStore()
    const clock = new FixedClock(100)
    const supervisor = new TaskSupervisor({
      store,
      clock,
      createId: (): string => 'ci-watch-1',
    })
    const requests: Parameters<CiWatchDispatcher['dispatchMachine']>[0][] = []
    const dispose = installCiWatchConsumer(
      supervisor,
      {
        dispatchMachine: (request): Promise<'completed'> => {
          requests.push(request)
          return Promise.resolve('completed')
        },
      },
      dependencies(clock, [status('pending'), status('pending'), status('failure')]),
    )

    try {
      await supervisor.start()
      await nextTurn()
      const scheduled = await scheduleCiWatch({
        context,
        turnTreeId,
        timeoutMs: 7_200_000,
        pollIntervalMs: 60_000,
      })
      assert.equal(scheduled.watching, true)
      assert.equal(scheduled.taskId, 'ci-watch-1')

      clock.fire()
      await supervisor.waitForIdle()
      assert.equal(store.tasks.get('ci-watch-1')?.state, 'waiting')
      assert.deepEqual(store.tasks.get('ci-watch-1')?.handlerInput?.['consecutiveErrors'], 0)

      clock.fire()
      await supervisor.waitForIdle()
      assert.equal(requests.length, 1)
      const request = requests[0]
      assert.ok(request)
      assert.equal(request.operationId, 'ci-watch-1')
      assert.equal(store.tasks.get('ci-watch-1')?.state, 'completed')
      const prompt = request.payload.userContent
      if (typeof prompt !== 'string') assert.fail('expected a text continuation prompt')
      assert.match(prompt, /CI is failure/)
      assert.match(prompt, /Failed checks: test/)
    } finally {
      dispose()
      await supervisor.shutdown()
    }
  })

  it('checks persisted watches immediately after restart and resumes on a missed transition', async () => {
    const store = new MemoryStore()
    const firstClock = new FixedClock(100)
    const firstSupervisor = new TaskSupervisor({
      store,
      clock: firstClock,
      createId: (): string => 'ci-watch-restart',
    })
    const firstDispose = installCiWatchConsumer(
      firstSupervisor,
      { dispatchMachine: (): Promise<'completed'> => Promise.resolve('completed') },
      dependencies(firstClock, [status('pending')]),
    )
    await firstSupervisor.start()
    await nextTurn()
    await scheduleCiWatch({
      context,
      turnTreeId,
      timeoutMs: 7_200_000,
      pollIntervalMs: 60_000,
    })
    firstDispose()
    await firstSupervisor.shutdown()

    const secondClock = new FixedClock(1_000)
    const secondSupervisor = new TaskSupervisor({ store, clock: secondClock })
    const requests: Parameters<CiWatchDispatcher['dispatchMachine']>[0][] = []
    const secondDispose = installCiWatchConsumer(
      secondSupervisor,
      {
        dispatchMachine: (request): Promise<'completed'> => {
          requests.push(request)
          return Promise.resolve('completed')
        },
      },
      dependencies(secondClock, [status('failure')]),
    )

    try {
      await secondSupervisor.start()
      await nextTurn()
      await secondSupervisor.waitForIdle()
      assert.equal(requests.length, 1)
      assert.equal(requests[0]?.operationId, 'ci-watch-restart')
      assert.equal(store.tasks.get('ci-watch-restart')?.state, 'completed')
    } finally {
      secondDispose()
      await secondSupervisor.shutdown()
    }
  })

  it('dispatches on expiry even when the final status read fails', async () => {
    const store = new MemoryStore()
    const clock = new FixedClock(100)
    const supervisor = new TaskSupervisor({
      store,
      clock,
      createId: (): string => 'ci-watch-expiry',
    })
    const requests: Parameters<CiWatchDispatcher['dispatchMachine']>[0][] = []
    let reads = 0
    const dispose = installCiWatchConsumer(
      supervisor,
      {
        dispatchMachine: (request): Promise<'completed'> => {
          requests.push(request)
          return Promise.resolve('completed')
        },
      },
      dependencies(clock, [], {
        readStatus: (): Promise<CiStatus> => {
          reads++
          if (reads === 1) return Promise.resolve(status('pending'))
          return Promise.reject(new Error('GitHub unavailable'))
        },
      }),
    )

    try {
      await supervisor.start()
      await nextTurn()
      await scheduleCiWatch({
        context,
        turnTreeId,
        timeoutMs: 60_000,
        pollIntervalMs: 60_000,
      })

      clock.fire()
      await supervisor.waitForIdle()
      assert.equal(requests.length, 1)
      assert.equal(store.tasks.get('ci-watch-expiry')?.state, 'completed')
      const request = requests[0]
      assert.ok(request)
      const prompt = request.payload.userContent
      if (typeof prompt !== 'string') assert.fail('expected a text continuation prompt')
      assert.match(prompt, /watch expired and the final CI status could not be read/)
    } finally {
      dispose()
      await supervisor.shutdown()
    }
  })

  it('rebinds an existing watch when a newer human turn takes ownership', async () => {
    const store = new MemoryStore()
    const clock = new FixedClock(100)
    let nextTaskId = 0
    const supervisor = new TaskSupervisor({
      store,
      clock,
      createId: (): string => `ci-watch-${String(++nextTaskId)}`,
    })
    const dispose = installCiWatchConsumer(
      supervisor,
      { dispatchMachine: (): Promise<'completed'> => Promise.resolve('completed') },
      dependencies(clock, [status('pending'), status('pending')]),
    )

    try {
      await supervisor.start()
      await nextTurn()
      const first = await scheduleCiWatch({
        context,
        turnTreeId,
        timeoutMs: 7_200_000,
        pollIntervalMs: 60_000,
      })
      const secondTurnTreeId = asTurnTreeId('tree-2')
      const second = await scheduleCiWatch({
        context,
        turnTreeId: secondTurnTreeId,
        timeoutMs: 7_200_000,
        pollIntervalMs: 60_000,
      })

      assert.notEqual(second.taskId, first.taskId)
      assert.equal(store.tasks.get('ci-watch-1')?.state, 'cancelled')
      assert.equal(store.tasks.get('ci-watch-2')?.turnId, secondTurnTreeId)
    } finally {
      dispose()
      await supervisor.shutdown()
    }
  })
})
