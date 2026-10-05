import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUTOMATIONS_PLUGIN_ID } from '@copse/agent/plugins/automations-plugin.ts'
import type { Thread } from '@shared/types'
import { storageSet } from '../storage/storage.ts'
import { FileSupervisedTaskStore } from '../supervisor/task-store.ts'
import { TaskSupervisor, type TaskSupervisorClock } from '../supervisor/task-supervisor.ts'
import { createAutomationService } from './automation-service.ts'

const STORAGE_KEY = `plugin.${AUTOMATIONS_PLUGIN_ID}.storage`
const SCHEDULER_HANDLER = 'automation_scheduler_tick'

/** Timers fire only when the test advances time; `now()` moves with them. */
class FakeClock implements TaskSupervisorClock {
  private value: number
  private elapsed = 0
  private nextId = 1
  private readonly timers = new Map<number, { at: number; callback: () => void }>()

  constructor(start: number) {
    this.value = start
  }

  now(): number {
    return this.value
  }

  setTimeout(callback: () => void, delayMs: number): number {
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
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (condition()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`Timed out waiting for ${what}`)
}

/**
 * Shutdown gives a handler that ignores cancellation a grace period measured on
 * the supervisor's clock, so a fake clock has to be walked forward to let it end.
 */
async function shutDown(supervisor: TaskSupervisor, clock: FakeClock): Promise<void> {
  const progress = { done: false }
  const stopped = supervisor.shutdown().then(() => {
    progress.done = true
  })
  while (!progress.done) {
    clock.advanceBy(5_000)
    await new Promise<void>((resolve) => setTimeout(resolve, 2))
  }
  await stopped
}

function liveSchedulerTasks(supervisor: TaskSupervisor): ReturnType<TaskSupervisor['list']> {
  return supervisor
    .list()
    .filter(
      (task) =>
        task.handler === SCHEDULER_HANDLER &&
        task.state !== 'cancelled' &&
        task.state !== 'failed' &&
        task.state !== 'completed',
    )
}

/**
 * The automation service against the real supervisor and its on-disk task store,
 * with only the clock faked. These are the ways the minute scheduler used to
 * stop for good: the supervisor's behaviour is what the fixes depend on, so a
 * fake supervisor cannot vouch for them.
 */
describe('automation scheduler on the real supervisor', () => {
  let root: string
  let env: { COPSE_WORKSPACE_DIR: string }
  let clock: FakeClock
  let supervisors: TaskSupervisor[]
  let stoppers: Array<() => void>
  let triggered: string[]
  let hang: Set<string>

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'copse-automation-scheduler-'))
    env = { COPSE_WORKSPACE_DIR: root }
    clock = new FakeClock(new Date(2026, 6, 27, 9, 0, 30).getTime())
    supervisors = []
    stoppers = []
    triggered = []
    hang = new Set()
    storageSet(
      STORAGE_KEY,
      ['slow', 'quick'].map((id) => ({
        id,
        projectId: 'project-a',
        name: id,
        cron: '* * * * *',
        prompt: 'p',
        model: 'm',
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
      })),
    )
  })

  afterEach(async () => {
    for (const stop of stoppers) stop()
    for (const supervisor of supervisors) await shutDown(supervisor, clock)
    await rm(root, { recursive: true, force: true })
  })

  function boot(): {
    supervisor: TaskSupervisor
    service: ReturnType<typeof createAutomationService>
  } {
    const supervisor = new TaskSupervisor({
      store: new FileSupervisedTaskStore(env),
      clock,
      cronEnabled: (): boolean => true,
      onError: (): void => {},
    })
    supervisors.push(supervisor)
    const service = createAutomationService({
      now: () => clock.now(),
      isPluginEnabled: () => true,
      createProjectThread: (_projectId, thread: Thread) => {
        triggered.push(thread.title)
        return hang.has(thread.title) ? new Promise<void>(() => {}) : Promise.resolve()
      },
      loadProjectThreads: () => Promise.resolve([]),
      releasePreviousRun: () => Promise.resolve({ released: true }),
      supervisor: () => supervisor,
      recoveryDelayMs: 0,
    })
    stoppers.push(() => {
      service.stop()
    })
    return { supervisor, service }
  }

  async function minute(): Promise<void> {
    clock.advanceBy(60_000)
    // Let the supervisor persist the wake and hand the tick to the service.
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }

  it('keeps ticking after a tick overruns its duration budget', { timeout: 20_000 }, async () => {
    hang.add('slow')
    const { supervisor, service } = boot()
    service.start(() => {})
    await service.sync()
    const [original] = liveSchedulerTasks(supervisor)
    assert.ok(original)

    await minute()
    // The slow schedule never finishes, but it must not hold the quick one back.
    await until(
      () => triggered.includes('quick'),
      'the quick schedule to run alongside the slow one',
    )
    const quickBefore = triggered.filter((title) => title === 'quick').length

    clock.advanceBy(130_000)
    await until(
      () => supervisor.get(original.projectId, original.taskId)?.state === 'failed',
      'the overrunning scheduler task to fail',
    )
    await until(
      () => liveSchedulerTasks(supervisor).some((task) => task.taskId !== original.taskId),
      'a replacement scheduler task',
    )

    await minute()
    await until(
      () => triggered.filter((title) => title === 'quick').length > quickBefore,
      'the replacement scheduler to run the next minute',
    )
    assert.equal(liveSchedulerTasks(supervisor).length, 1)
  })

  it(
    'resumes ticking after the app quits in the middle of a tick',
    { timeout: 20_000 },
    async () => {
      hang.add('slow')
      const first = boot()
      first.service.start(() => {})
      await first.service.sync()
      await minute()
      await until(() => triggered.includes('quick'), 'the interrupted tick to be underway')
      const before = triggered.length

      await shutDown(first.supervisor, clock)
      first.service.stop()
      hang.clear()

      const second = boot()
      second.service.start(() => {})
      await second.service.sync()

      await until(() => triggered.length > before, 'the interrupted tick to run again on relaunch')
      assert.equal(liveSchedulerTasks(second.supervisor).length, 1)
      assert.ok(liveSchedulerTasks(second.supervisor).every((task) => task.state !== 'blocked'))
    },
  )

  it(
    'replaces a scheduler task an older build left blocked by an interrupted restart',
    { timeout: 20_000 },
    async () => {
      // An older build enqueued the tick without a restart policy, so quitting mid-tick
      // left it blocked on disk with nothing that would ever wake it.
      const legacy = new TaskSupervisor({
        store: new FileSupervisedTaskStore(env),
        clock,
        cronEnabled: (): boolean => true,
        onError: (): void => {},
      })
      supervisors.push(legacy)
      legacy.registerHandler(SCHEDULER_HANDLER, () => new Promise(() => {}))
      const task = await legacy.enqueue({
        projectId: 'project-a',
        threadId: 'slow',
        handler: SCHEDULER_HANDLER,
        provenance: 'schedule',
        trigger: { kind: 'cron', expression: '* * * * *' },
        permissionSnapshot: {
          capturedAt: 0,
          autoRunSandboxCommands: false,
          projectSandboxEnabled: false,
        },
        reapproveOnWake: false,
        concurrencyClass: 'schedule',
        resourceBudget: { maxDurationMs: 30_000 },
        maxAttempts: 1,
        contentHash: SCHEDULER_HANDLER,
      })
      await minute()
      await until(
        () => legacy.get(task.projectId, task.taskId)?.state === 'running',
        'the tick to start',
      )
      await shutDown(legacy, clock)
      clock.advanceBy(0)

      const { supervisor, service } = boot()
      service.start(() => {})
      await service.sync()
      assert.equal(supervisor.get(task.projectId, task.taskId)?.state, 'cancelled')
      assert.equal(liveSchedulerTasks(supervisor).length, 1)

      await minute()
      await until(() => triggered.includes('quick'), 'the replacement scheduler to run')
    },
  )
})
