import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUTOMATIONS_PLUGIN_ID } from '@copse/agent/plugins/automations-plugin.ts'
import type {
  AutomationPermission,
  AutomationScheduleInput,
  AutomationTriggerEvent,
  StreamChunk,
  Thread,
} from '@shared/types'
import type { SupervisedTaskMeta } from '@shared/supervisor/task-schema.ts'
import type {
  EnqueueSupervisedTaskInput,
  SupervisedTaskHandler,
} from '../supervisor/task-supervisor.ts'
import type { AutomationWorktreeRelease } from '../worktree-parking.ts'
import type { AgentDispatchRequest } from '../agent-dispatcher.ts'
import { storageGet, storageSet } from '../storage/storage.ts'
import { createThread, getThreadMeta, updateMetaOrThrow } from '../thread-store.ts'
import {
  createAutomationService,
  type AutomationTaskSupervisor,
  type DispatchHeadlessTurn,
} from './automation-service.ts'

const STORAGE_KEY = `plugin.${AUTOMATIONS_PLUGIN_ID}.storage`
const SCHEDULER_HANDLER = 'automation_scheduler_tick'
// Mirrors automation-service.ts's SCHEDULER_TRIGGER_TIMEOUT_MS.
const SCHEDULER_TRIGGER_TIMEOUT_MS = 90_000

/**
 * Durable tasks only become visible once `start()` has replayed them off disk,
 * which is the ordering the real supervisor imposes on a cold launch.
 */
class FakeTaskSupervisor implements AutomationTaskSupervisor {
  readonly enqueued: EnqueueSupervisedTaskInput[] = []
  readonly cancelled: string[] = []
  syncCalls = 0
  private readonly durable: SupervisedTaskMeta[]
  private tasks: SupervisedTaskMeta[] = []
  private started: Promise<void> | null = null
  private nextId = 0
  private readonly listeners = new Set<(task: SupervisedTaskMeta) => void>()

  constructor(durable: readonly SupervisedTaskMeta[] = []) {
    this.durable = [...durable]
  }

  start(): Promise<void> {
    // Idempotent, like the real supervisor's memoised `startPromise`.
    if (!this.started) {
      this.tasks = [...this.durable]
      this.started = Promise.resolve()
    }
    return this.started
  }

  syncCronTasks(): void {
    this.syncCalls += 1
  }

  list(projectId?: string): SupervisedTaskMeta[] {
    return this.tasks.filter((task) => projectId === undefined || task.projectId === projectId)
  }

  cancel(projectId: string, taskId: string): Promise<SupervisedTaskMeta | null> {
    this.cancelled.push(taskId)
    const task = this.tasks.find(
      (candidate) => candidate.projectId === projectId && candidate.taskId === taskId,
    )
    if (!task) return Promise.resolve(null)
    const next: SupervisedTaskMeta = { ...task, state: 'cancelled' }
    this.tasks = this.tasks.map((candidate) => (candidate === task ? next : candidate))
    return Promise.resolve(next)
  }

  enqueue(input: EnqueueSupervisedTaskInput): Promise<SupervisedTaskMeta> {
    this.enqueued.push(input)
    this.nextId += 1
    const task = schedulerTask({
      taskId: `enqueued-${String(this.nextId)}`,
      projectId: input.projectId,
      threadId: input.threadId,
    })
    this.tasks = [...this.tasks, task]
    return Promise.resolve(task)
  }

  handler: SupervisedTaskHandler | null = null

  registerHandler(_kind: string, handler: SupervisedTaskHandler): () => void {
    this.handler = handler
    return () => {
      this.handler = null
    }
  }

  subscribe(listener: (task: SupervisedTaskMeta) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Move a task to a new state and tell subscribers, as the real supervisor does. */
  setState(taskId: string, state: SupervisedTaskMeta['state']): void {
    const task = this.tasks.find((candidate) => candidate.taskId === taskId)
    if (!task) throw new Error(`No task ${taskId}`)
    const next: SupervisedTaskMeta = { ...task, state }
    this.tasks = this.tasks.map((candidate) => (candidate === task ? next : candidate))
    for (const listener of this.listeners) listener(next)
  }
}

function schedulerTask(input: {
  taskId: string
  projectId: string
  threadId: string
}): SupervisedTaskMeta {
  return {
    taskId: input.taskId,
    projectId: input.projectId,
    threadId: input.threadId,
    handler: SCHEDULER_HANDLER,
    provenance: 'schedule',
    state: 'waiting',
    createdAt: 0,
    updatedAt: 0,
    trigger: { kind: 'cron', expression: '* * * * *' },
    permissionSnapshot: {
      capturedAt: 0,
      autoRunSandboxCommands: false,
      projectSandboxEnabled: false,
    },
    reapproveOnWake: false,
    concurrencyClass: 'schedule',
    attempt: 0,
    maxAttempts: 1,
  }
}

describe('AutomationService', () => {
  beforeEach(() => {
    storageSet(STORAGE_KEY, [])
  })

  it('keeps schedules project-scoped and preserves the chosen model', async () => {
    let now = new Date(2026, 6, 27, 9, 0, 5).getTime()
    const created: Array<{ projectId: string; thread: Thread }> = []
    const service = createAutomationService({
      now: () => now,
      isPluginEnabled: () => true,
      createProjectThread: (projectId, thread) => {
        created.push({ projectId, thread })
        return Promise.resolve()
      },
      loadProjectThreads: () => Promise.resolve([]),
      releasePreviousRun: () => Promise.resolve({ released: true }),
      getActiveProjectId: () => 'project-a',
    })

    const schedule = await service.upsert('project-a', {
      name: 'Morning review',
      cron: '0 9 * * 1-5',
      prompt: 'Review the current project.',
      model: 'gpt-5.4',
      enabled: true,
    })
    assert.equal(service.list('project-b').length, 0)

    await service.tick()
    assert.equal(created.length, 1)
    const first = created[0]
    assert.ok(first)
    assert.equal(first.projectId, 'project-a')
    assert.equal(first.thread.model, 'gpt-5.4')
    assert.equal(first.thread.draftPrompt, 'Review the current project.')
    assert.equal(first.thread.automation?.scheduleId, schedule.id)

    // A second tick in the same minute cannot duplicate the task.
    now += 15_000
    await service.tick()
    assert.equal(created.length, 1)
  })

  it('stores unique opt-in permissions and can add one from a running schedule', async () => {
    let now = 10
    const created: Thread[] = []
    const service = createAutomationService({
      now: () => now,
      isPluginEnabled: () => true,
      createProjectThread: (_projectId, thread) => {
        created.push(thread)
        return Promise.resolve()
      },
      loadProjectThreads: () => Promise.resolve([]),
      releasePreviousRun: () => Promise.resolve({ released: true }),
      getActiveProjectId: () => 'project-a',
    })
    const approve: AutomationPermission = { kind: 'copse-action', toolName: 'gh_pr_approve' }
    const autoMerge: AutomationPermission = {
      kind: 'copse-action',
      toolName: 'gh_pr_enable_auto_merge',
    }
    const permissionOptions = service.permissionOptions()
    assert.deepEqual(
      permissionOptions
        .filter((option) => option.permission.kind === 'copse-action')
        .map((option) => option.permission.toolName),
      [
        'gh_pr_create',
        'gh_pr_rerun_failed_ci',
        'gh_pr_approve',
        'gh_pr_mark_ready',
        'gh_pr_enable_auto_merge',
      ],
    )
    assert.equal(
      new Set(permissionOptions.map((option) => JSON.stringify(option.permission))).size,
      permissionOptions.length,
    )
    const schedule = await service.upsert('project-a', {
      name: 'Pull request caretaker',
      cron: '0 9 * * 1-5',
      prompt: 'Keep the pull request moving.',
      model: 'gpt-5.4',
      enabled: true,
      permissions: [approve, approve],
    })

    assert.deepEqual(schedule.permissions, [approve])
    const run = await service.runNow('project-a', schedule.id)
    const automation = created[0]?.automation
    assert.ok(automation)
    assert.equal(service.ownsRunThread('project-a', run.threadId, automation), true)
    assert.equal(service.ownsRunThread('project-b', run.threadId, automation), false)
    assert.equal(service.ownsRunThread('project-a', 'other-thread', automation), false)
    assert.equal(
      service.ownsRunThread('project-a', run.threadId, {
        ...automation,
        triggeredAt: automation.triggeredAt + 1,
      }),
      false,
    )
    assert.deepEqual(
      service.permissionPreferenceForThread('project-a', run.threadId, automation, approve),
      {
        scheduleName: schedule.name,
        allowed: true,
      },
    )
    assert.equal(
      service.permissionPreferenceForThread('project-b', run.threadId, automation, approve),
      null,
      'a grant cannot cross its project boundary',
    )
    assert.equal(
      service.permissionPreferenceForThread(
        'project-a',
        'ordinary-renderer-thread',
        automation,
        approve,
      ),
      null,
      'renderer-visible provenance cannot attach a schedule grant to another thread',
    )
    assert.equal(
      service.permissionPreferenceForThread(
        'project-a',
        run.threadId,
        { ...automation, triggeredAt: automation.triggeredAt + 1 },
        approve,
      ),
      null,
      'renderer-visible provenance must match the recorded schedule run time',
    )

    now = 20
    assert.equal(await service.grantPermission('project-a', schedule.id, autoMerge), true)
    assert.equal(
      service.permissionPreferenceForThread('project-a', run.threadId, automation, autoMerge)
        ?.allowed,
      true,
    )
    assert.equal(service.list('project-a')[0]?.updatedAt, 20)

    assert.equal(
      await service.grantPermission('project-a', schedule.id, {
        kind: 'copse-action',
        toolName: 'unregistered_action',
      }),
      false,
    )
    assert.equal(
      await service.grantPermission('project-a', schedule.id, {
        kind: 'mcp-tool',
        toolName: `mcp__server__${'x'.repeat(512)}`,
      }),
      false,
    )
    assert.equal(service.list('project-a')[0]?.permissions?.length, 2)
  })

  it('only accepts picker permissions, while preserving a saved tool that went offline', async () => {
    const service = createAutomationService({
      now: () => 1,
      isPluginEnabled: () => true,
      createProjectThread: () => Promise.resolve(),
      loadProjectThreads: () => Promise.resolve([]),
      releasePreviousRun: () => Promise.resolve({ released: true }),
      getActiveProjectId: () => 'project-a',
    })
    await assert.rejects(
      () =>
        service.upsert('project-a', {
          name: 'Unsafe seed',
          cron: '* * * * *',
          prompt: 'Run.',
          model: 'gpt-5.4',
          enabled: true,
          permissions: [{ kind: 'mcp-tool', toolName: 'mcp__offline__unknown' }],
        }),
      /permission is not available/,
    )

    storageSet(STORAGE_KEY, [
      {
        id: 'existing',
        projectId: 'project-a',
        name: 'Existing',
        cron: '* * * * *',
        prompt: 'Run.',
        model: 'gpt-5.4',
        enabled: true,
        permissions: [
          { kind: 'mcp-tool', toolName: 'mcp__offline__publish_report' },
          { kind: 'mcp-tool', toolName: 'mcp__offline__publish_report' },
        ],
        createdAt: 0,
        updatedAt: 0,
      },
    ])
    assert.equal(service.list('project-a')[0]?.permissions?.length, 1)
    const updated = await service.upsert('project-a', {
      id: 'existing',
      name: 'Existing',
      cron: '* * * * *',
      prompt: 'Run again.',
      model: 'gpt-5.4',
      enabled: true,
      permissions: [{ kind: 'mcp-tool', toolName: 'mcp__offline__publish_report' }],
    })
    assert.equal(updated.permissions?.[0]?.toolName, 'mcp__offline__publish_report')
  })

  it('does not trigger while the plugin is disabled, but keeps configuration', async () => {
    let pluginEnabled = false
    let created = 0
    const service = createAutomationService({
      now: () => new Date(2026, 6, 27, 9, 0, 0).getTime(),
      isPluginEnabled: () => pluginEnabled,
      createProjectThread: () => {
        created += 1
        return Promise.resolve()
      },
      loadProjectThreads: () => Promise.resolve([]),
      releasePreviousRun: () => Promise.resolve({ released: true }),
      getActiveProjectId: () => 'project-a',
    })
    const schedule = await service.upsert('project-a', {
      name: 'Review',
      cron: '* * * * *',
      prompt: 'Review.',
      model: 'gpt-5.4',
      enabled: true,
    })

    await service.tick()
    assert.equal(created, 0)
    assert.equal(service.list('project-a').length, 1)
    await assert.rejects(() => service.runNow('project-a', schedule.id), /Enable the automations/)

    pluginEnabled = true
    await service.runNow('project-a', schedule.id)
    assert.equal(created, 1)
  })

  it('rejects cross-project update and run attempts', async () => {
    const service = createAutomationService({
      now: () => 1,
      isPluginEnabled: () => true,
      createProjectThread: () => Promise.resolve(),
      loadProjectThreads: () => Promise.resolve([]),
      releasePreviousRun: () => Promise.resolve({ released: true }),
      getActiveProjectId: () => 'project-a',
    })
    const schedule = await service.upsert('project-a', {
      name: 'Review',
      cron: '* * * * *',
      prompt: 'Review.',
      model: 'gpt-5.4',
      enabled: true,
    })
    await assert.rejects(
      () =>
        service.upsert('project-b', {
          id: schedule.id,
          name: 'Hijack',
          cron: '* * * * *',
          prompt: 'No.',
          model: 'gpt-5.4',
          enabled: true,
        }),
      /not found in this project/,
    )
    await assert.rejects(
      () => service.runNow('project-b', schedule.id),
      /not found in this project/,
    )
  })

  it('does not resurrect a schedule deleted while a run is loading', async () => {
    let releaseThreads: ((threads: Thread[]) => void) | undefined
    const pendingThreads = new Promise<Thread[]>((resolve) => {
      releaseThreads = resolve
    })
    const service = createAutomationService({
      now: () => 1,
      isPluginEnabled: () => true,
      createProjectThread: () => Promise.resolve(),
      loadProjectThreads: () => pendingThreads,
      releasePreviousRun: () => Promise.resolve({ released: true }),
      getActiveProjectId: () => 'project-a',
    })
    const schedule = await service.upsert('project-a', {
      name: 'Review',
      cron: '* * * * *',
      prompt: 'Review.',
      model: 'gpt-5.4',
      enabled: true,
    })

    const run = service.runNow('project-a', schedule.id)
    await service.remove('project-a', schedule.id)
    releaseThreads?.([])
    await run

    assert.deepEqual(service.list('project-a'), [])
  })

  it('preserves an edit made while a run is loading', async () => {
    let now = 1
    let releaseThreads: ((threads: Thread[]) => void) | undefined
    const pendingThreads = new Promise<Thread[]>((resolve) => {
      releaseThreads = resolve
    })
    const service = createAutomationService({
      now: () => now,
      isPluginEnabled: () => true,
      createProjectThread: () => Promise.resolve(),
      loadProjectThreads: () => pendingThreads,
      releasePreviousRun: () => Promise.resolve({ released: true }),
      getActiveProjectId: () => 'project-a',
    })
    const schedule = await service.upsert('project-a', {
      name: 'Old review',
      cron: '* * * * *',
      prompt: 'Old prompt.',
      model: 'gpt-5.4',
      enabled: true,
    })

    const run = service.runNow('project-a', schedule.id)
    now = 2
    await service.upsert('project-a', {
      id: schedule.id,
      name: 'Updated review',
      cron: '0 9 * * *',
      prompt: 'Updated prompt.',
      model: 'best-value',
      enabled: false,
    })
    releaseThreads?.([])
    const event = await run

    assert.deepEqual(service.list('project-a'), [
      {
        ...schedule,
        name: 'Updated review',
        cron: '0 9 * * *',
        prompt: 'Updated prompt.',
        model: 'best-value',
        enabled: false,
        updatedAt: 2,
        lastRunAt: 1,
        lastCreatedThreadId: event.threadId,
      },
    ])
  })

  it('isolates a failed schedule and does not retry it within the same minute', async () => {
    let attempts = 0
    const service = createAutomationService({
      now: () => new Date(2026, 6, 27, 9, 0, 0).getTime(),
      isPluginEnabled: () => true,
      createProjectThread: () => {
        attempts += 1
        return attempts === 1 ? Promise.reject(new Error('disk unavailable')) : Promise.resolve()
      },
      loadProjectThreads: () => Promise.resolve([]),
      releasePreviousRun: () => Promise.resolve({ released: true }),
      getActiveProjectId: () => 'project-a',
    })
    await service.upsert('project-a', {
      name: 'First',
      cron: '* * * * *',
      prompt: 'First.',
      model: 'gpt-5.4',
      enabled: true,
    })
    await service.upsert('project-a', {
      name: 'Second',
      cron: '* * * * *',
      prompt: 'Second.',
      model: 'gpt-5.4',
      enabled: true,
    })

    await service.tick()
    assert.equal(attempts, 2)
    await service.tick()
    assert.equal(attempts, 2)
  })

  it('starts each completed run in a fresh thread and coalesces while prior work is active', async () => {
    let now = new Date(2026, 6, 27, 9, 0, 0).getTime()
    const threads = new Map<string, Thread>()
    const service = createAutomationService({
      now: () => now,
      isPluginEnabled: () => true,
      createProjectThread: (_projectId, thread) => {
        threads.set(thread.id, thread)
        return Promise.resolve()
      },
      loadProjectThreads: () => Promise.resolve([...threads.values()]),
      releasePreviousRun: () => Promise.resolve({ released: true }),
      getActiveProjectId: () => 'project-a',
    })
    const schedule = await service.upsert('project-a', {
      name: 'Project health',
      cron: '* * * * *',
      prompt: 'Check project health.',
      model: 'gpt-5.4',
      enabled: true,
    })
    const first = await service.runNow('project-a', schedule.id)
    assert.equal(first.disposition, 'started')
    const pending = threads.get(first.threadId)
    assert.ok(pending)
    threads.set(first.threadId, { ...pending, status: 'running', draftPrompt: '' })

    now += 60_000
    const overlap = await service.runNow('project-a', schedule.id)
    assert.equal(overlap.disposition, 'coalesced')
    assert.equal(overlap.threadId, first.threadId)
    assert.equal(threads.size, 1)

    const running = threads.get(first.threadId)
    assert.ok(running)
    threads.set(first.threadId, {
      ...running,
      status: 'idle',
      messages: [
        {
          id: 'answer',
          role: 'assistant',
          content: 'Healthy.',
          toolCalls: [],
          createdAt: now,
        },
      ],
    })
    now += 60_000
    const next = await service.runNow('project-a', schedule.id)
    assert.equal(next.disposition, 'started')
    assert.notEqual(next.threadId, first.threadId)
    assert.equal(threads.size, 2)
    assert.equal(threads.get(first.threadId)?.draftPrompt, '')
    assert.equal(threads.get(first.threadId)?.messages.length, 1)
    assert.equal(threads.get(next.threadId)?.draftPrompt, 'Check project health.')
    assert.equal(threads.get(next.threadId)?.messages.length, 0)
  })

  describe('handing a retained checkout to the next run', () => {
    async function setup(options: {
      canReuse: (threadId: string) => Promise<boolean>
      release?: () => Promise<AutomationWorktreeRelease>
    }): Promise<{
      service: ReturnType<typeof createAutomationService>
      schedule: { id: string }
      first: AutomationTriggerEvent
      threads: Map<string, Thread>
      triggerNext: () => Promise<AutomationTriggerEvent>
      advance: () => void
    }> {
      let now = new Date(2026, 6, 27, 9, 0, 0).getTime()
      const threads = new Map<string, Thread>()
      const events: AutomationTriggerEvent[] = []
      const service = createAutomationService({
        now: () => now,
        isPluginEnabled: () => true,
        createProjectThread: (_projectId, thread) => {
          threads.set(thread.id, thread)
          return Promise.resolve()
        },
        loadProjectThreads: () => Promise.resolve([...threads.values()]),
        releasePreviousRun:
          options.release ??
          ((): Promise<AutomationWorktreeRelease> =>
            Promise.resolve({ released: false, reason: 'unmerged-commits' })),
        canReusePreviousRun: (_projectId, threadId): Promise<boolean> => options.canReuse(threadId),
        supervisor: () => new FakeTaskSupervisor(),
        getActiveProjectId: () => 'project-a',
      })
      service.start(
        (event) => {
          events.push(event)
        },
        async () => {},
      )
      const schedule = await service.upsert('project-a', {
        name: 'Project health',
        cron: '* * * * *',
        prompt: 'Check project health.',
        model: 'gpt-5.4',
        enabled: true,
      })
      const first = await service.runNow('project-a', schedule.id)
      const pending = threads.get(first.threadId)
      assert.ok(pending)
      threads.set(first.threadId, {
        ...pending,
        status: 'idle',
        draftPrompt: '',
        worktree: {
          path: '/worktrees/first',
          branch: 'codex/first',
          baseBranch: 'main',
          baseCommit: 'a'.repeat(40),
          createdAt: now,
          seededFromDirtyProject: false,
        },
      })
      now += 60_000
      return {
        service,
        schedule,
        first,
        threads,
        triggerNext: async (): Promise<AutomationTriggerEvent> => {
          await service.tick()
          const event = events.at(-1)
          assert.ok(event)
          assert.equal(event.triggeredAt, now)
          return event
        },
        advance: (): void => {
          now += 60_000
        },
      }
    }

    it('does not count the checkout the next run will take over against the cap', async () => {
      const { service, first, threads, triggerNext } = await setup({
        canReuse: () => Promise.resolve(true),
      })
      const next = await triggerNext()
      assert.equal(next.disposition, 'started')
      assert.notEqual(next.threadId, first.threadId)
      assert.equal(threads.size, 2)
      assert.equal(service.list('project-a')[0]?.lastWorktreeLimitAt, undefined)
    })

    it('still enforces the cap when the checkout cannot be handed on', async () => {
      const { threads, triggerNext } = await setup({ canReuse: () => Promise.resolve(false) })
      const next = await triggerNext()
      assert.equal(next.disposition, 'coalesced')
      assert.equal(next.coalescedReason, 'worktree-limit')
      assert.equal(threads.size, 1)
    })

    it('treats a failing hand-over check, or release, as a retained checkout', async () => {
      const failingCheck = await setup({ canReuse: () => Promise.reject(new Error('git failed')) })
      assert.equal((await failingCheck.triggerNext()).coalescedReason, 'worktree-limit')
      const failingRelease = await setup({
        canReuse: () => Promise.resolve(false),
        release: () => Promise.reject(new Error('worktree is missing')),
      })
      const outcome = await failingRelease.triggerNext()
      assert.equal(outcome.coalescedReason, 'worktree-limit')
    })

    it('allows only one hand-over per run, so a higher cap still bounds the total', async () => {
      const { threads, first, advance, triggerNext } = await setup({
        canReuse: (threadId) => Promise.resolve(threadId === first.threadId),
      })
      // A second retained checkout (cap 1) is not covered by the single hand-over.
      const second = await triggerNext()
      assert.equal(second.disposition, 'started')
      const pending = threads.get(second.threadId)
      assert.ok(pending)
      threads.set(second.threadId, {
        ...pending,
        status: 'idle',
        draftPrompt: '',
        worktree: {
          path: '/worktrees/second',
          branch: 'codex/second',
          baseBranch: 'main',
          baseCommit: 'a'.repeat(40),
          createdAt: 1,
          seededFromDirtyProject: false,
        },
      })
      advance()
      const third = await triggerNext()
      assert.equal(third.coalescedReason, 'worktree-limit')
    })
  })

  it('does not allocate another worktree while the previous run retains changes', async () => {
    let now = new Date(2026, 6, 27, 9, 0, 0).getTime()
    const threads = new Map<string, Thread>()
    const events: AutomationTriggerEvent[] = []
    const supervisor = new FakeTaskSupervisor()
    const service = createAutomationService({
      now: () => now,
      isPluginEnabled: () => true,
      createProjectThread: (_projectId, thread) => {
        threads.set(thread.id, thread)
        return Promise.resolve()
      },
      loadProjectThreads: () => Promise.resolve([...threads.values()]),
      releasePreviousRun: () =>
        Promise.resolve({ released: false, reason: 'uncommitted-changes', paths: ['notes.md'] }),
      supervisor: () => supervisor,
      getActiveProjectId: () => 'project-a',
    })
    service.start(
      (event) => {
        events.push(event)
      },
      async () => {},
    )
    const schedule = await service.upsert('project-a', {
      name: 'Project health',
      cron: '* * * * *',
      prompt: 'Check project health.',
      model: 'gpt-5.4',
      enabled: true,
    })
    const first = await service.runNow('project-a', schedule.id)
    const pending = threads.get(first.threadId)
    assert.ok(pending)
    threads.set(first.threadId, {
      ...pending,
      status: 'idle',
      draftPrompt: '',
      worktree: {
        path: '/worktrees/first',
        branch: 'codex/first',
        baseBranch: 'main',
        baseCommit: 'a'.repeat(40),
        createdAt: now,
        seededFromDirtyProject: false,
      },
    })

    now += 60_000
    await service.tick()
    assert.equal(threads.size, 1)
    assert.equal(service.list('project-a')[0]?.lastWorktreeLimitAt, now)
    assert.equal(events.at(-1)?.coalescedReason, 'worktree-limit')
    assert.equal(events.at(-1)?.threadId, first.threadId)
    assert.deepEqual(events.at(-1)?.blockedBy, [
      {
        threadId: first.threadId,
        title: 'Project health',
        reason: 'uncommitted-changes',
        paths: ['notes.md'],
      },
    ])
    now += 60_000
    await service.tick()
    assert.equal(service.list('project-a')[0]?.lastWorktreeLimitAt, now)
    assert.equal(events.at(-1)?.triggeredAt, now)
    assert.equal(events.at(-1)?.coalescedReason, 'worktree-limit')

    const updated = await service.upsert('project-a', {
      id: schedule.id,
      name: schedule.name,
      cron: schedule.cron,
      prompt: schedule.prompt,
      model: schedule.model,
      enabled: schedule.enabled,
      maxLiveWorktrees: 2,
    })
    assert.equal(updated.maxLiveWorktrees, 2)
    assert.equal(service.list('project-a')[0]?.lastWorktreeLimitAt, undefined)
    const resumed = await service.runNow('project-a', schedule.id)
    assert.equal(resumed.disposition, 'started')
    assert.equal(threads.size, 2)
    service.stop()
  })

  it('allows a bounded number of retained worktrees when the schedule opts in', async () => {
    let now = new Date(2026, 6, 27, 9, 0, 0).getTime()
    const threads = new Map<string, Thread>()
    const service = createAutomationService({
      now: () => now,
      isPluginEnabled: () => true,
      createProjectThread: (_projectId, thread) => {
        threads.set(thread.id, thread)
        return Promise.resolve()
      },
      loadProjectThreads: () => Promise.resolve([...threads.values()]),
      releasePreviousRun: () =>
        Promise.resolve({ released: false, reason: 'uncommitted-changes', paths: ['notes.md'] }),
      getActiveProjectId: () => 'project-a',
    })
    const schedule = await service.upsert('project-a', {
      name: 'Project health',
      cron: '* * * * *',
      prompt: 'Check project health.',
      model: 'gpt-5.4',
      enabled: true,
      maxLiveWorktrees: 2,
    })
    const attachWorktree = (threadId: string): void => {
      const existing = threads.get(threadId)
      assert.ok(existing)
      threads.set(threadId, {
        ...existing,
        status: 'idle',
        draftPrompt: '',
        worktree: {
          path: `/worktrees/${threadId}`,
          branch: `codex/${threadId}`,
          baseBranch: 'main',
          baseCommit: 'a'.repeat(40),
          createdAt: now,
          seededFromDirtyProject: false,
        },
      })
    }

    const first = await service.runNow('project-a', schedule.id)
    attachWorktree(first.threadId)
    now += 60_000
    await service.tick()
    assert.equal(threads.size, 2)
    const second = [...threads.keys()].at(-1)
    assert.ok(second)
    assert.notEqual(second, first.threadId)

    attachWorktree(second)
    now += 60_000
    await service.tick()
    assert.equal(threads.size, 2)
    assert.equal(service.list('project-a')[0]?.lastWorktreeLimitAt, now)
  })

  it('starts a manual run past the live worktree limit and still names what is retained', async () => {
    let now = new Date(2026, 6, 27, 9, 0, 0).getTime()
    const threads = new Map<string, Thread>()
    const events: AutomationTriggerEvent[] = []
    const supervisor = new FakeTaskSupervisor()
    const service = createAutomationService({
      supervisor: () => supervisor,
      now: () => now,
      isPluginEnabled: () => true,
      createProjectThread: (_projectId, thread) => {
        threads.set(thread.id, thread)
        return Promise.resolve()
      },
      loadProjectThreads: () => Promise.resolve([...threads.values()]),
      releasePreviousRun: () => Promise.resolve({ released: false, reason: 'unmerged-commits' }),
      getActiveProjectId: () => 'project-a',
    })
    service.start(
      (event) => {
        events.push(event)
      },
      async () => {},
    )
    const schedule = await service.upsert('project-a', {
      name: 'Project health',
      cron: '* * * * *',
      prompt: 'Check project health.',
      model: 'gpt-5.4',
      enabled: true,
    })
    const first = await service.runNow('project-a', schedule.id)
    const pending = threads.get(first.threadId)
    assert.ok(pending)
    threads.set(first.threadId, {
      ...pending,
      status: 'idle',
      draftPrompt: '',
      worktree: {
        path: '/worktrees/first',
        branch: 'codex/first',
        baseBranch: 'main',
        baseCommit: 'a'.repeat(40),
        createdAt: now,
        seededFromDirtyProject: false,
      },
    })

    now += 60_000
    await service.tick()
    assert.equal(events.at(-1)?.coalescedReason, 'worktree-limit')
    assert.equal(threads.size, 1)
    assert.ok(service.list('project-a')[0]?.lastWorktreeLimitAt)

    now += 60_000
    const manual = await service.runNow('project-a', schedule.id)
    assert.equal(manual.disposition, 'started')
    assert.equal(threads.size, 2)
    assert.equal(service.list('project-a')[0]?.lastWorktreeLimitAt, undefined)
    service.stop()
  })
  it('cleans up finished runs through the scheduler release path and reports what must stay', async () => {
    const now = new Date(2026, 6, 27, 9, 0, 0).getTime()
    const threads = new Map<string, Thread>()
    const released: string[] = []
    const service = createAutomationService({
      now: () => now,
      isPluginEnabled: () => true,
      createProjectThread: (_projectId, thread) => {
        threads.set(thread.id, thread)
        return Promise.resolve()
      },
      loadProjectThreads: () => Promise.resolve([...threads.values()]),
      releasePreviousRun: (_projectId, threadId) => {
        if (threadId === 'dirty') {
          return Promise.resolve({
            released: false,
            reason: 'uncommitted-changes',
            paths: ['notes.md'],
          })
        }
        released.push(threadId)
        return Promise.resolve({ released: true })
      },
      getActiveProjectId: () => 'project-a',
    })
    const schedule = await service.upsert('project-a', {
      name: 'Project health',
      cron: '* * * * *',
      prompt: 'Check project health.',
      model: 'gpt-5.4',
      enabled: true,
    })
    const worktreeFor = (id: string, retiredAt?: number): NonNullable<Thread['worktree']> => ({
      path: `/worktrees/${id}`,
      branch: `codex/${id}`,
      baseBranch: 'main',
      baseCommit: 'a'.repeat(40),
      createdAt: now,
      seededFromDirtyProject: false,
      ...(retiredAt !== undefined ? { retiredAt } : {}),
    })
    const held = (id: string, status: Thread['status'], retiredAt?: number): Thread => ({
      id,
      title: 'Project health',
      status,
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      automation: { scheduleId: schedule.id, scheduleName: schedule.name, triggeredAt: now },
      worktree: worktreeFor(id, retiredAt),
      createdAt: now,
      updatedAt: now,
    })
    threads.set('clean', held('clean', 'idle'))
    threads.set('dirty', held('dirty', 'idle'))
    threads.set('running', held('running', 'running'))
    threads.set('retired', held('retired', 'idle', now))

    const result = await service.cleanupRuns('project-a', schedule.id)

    assert.deepEqual(released, ['clean'])
    assert.deepEqual(result.released, ['clean'])
    assert.deepEqual(result.retained, [
      {
        threadId: 'dirty',
        title: 'Project health',
        reason: 'uncommitted-changes',
        paths: ['notes.md'],
      },
    ])
  })

  it('clears a recorded worktree-limit skip once cleanup leaves room, and keeps it otherwise', async () => {
    let now = new Date(2026, 6, 27, 9, 0, 0).getTime()
    const threads = new Map<string, Thread>()
    let cleanReleased = false
    const service = createAutomationService({
      now: () => now,
      isPluginEnabled: () => true,
      createProjectThread: (_projectId, thread) => {
        threads.set(thread.id, thread)
        return Promise.resolve()
      },
      loadProjectThreads: () => Promise.resolve([...threads.values()]),
      releasePreviousRun: () =>
        Promise.resolve(
          cleanReleased
            ? { released: true }
            : { released: false, reason: 'unmerged-commits' as const },
        ),
      getActiveProjectId: () => 'project-a',
    })
    const schedule = await service.upsert('project-a', {
      name: 'Project health',
      cron: '* * * * *',
      prompt: 'Check project health.',
      model: 'gpt-5.4',
      enabled: true,
    })
    const first = await service.runNow('project-a', schedule.id)
    const pending = threads.get(first.threadId)
    assert.ok(pending)
    threads.set(first.threadId, {
      ...pending,
      status: 'idle',
      draftPrompt: '',
      worktree: {
        path: '/worktrees/first',
        branch: 'codex/first',
        baseBranch: 'main',
        baseCommit: 'a'.repeat(40),
        createdAt: now,
        seededFromDirtyProject: false,
      },
    })
    now += 60_000
    await service.tick()
    assert.ok(service.list('project-a')[0]?.lastWorktreeLimitAt)

    const stillHeld = await service.cleanupRuns('project-a', schedule.id)
    assert.equal(stillHeld.retained.length, 1)
    assert.ok(service.list('project-a')[0]?.lastWorktreeLimitAt)
    assert.equal(service.list('project-a')[0]?.lastWorktreeLimitBlockedBy?.length, 1)

    cleanReleased = true
    const freed = await service.cleanupRuns('project-a', schedule.id)
    assert.deepEqual(freed.released, [first.threadId])
    assert.equal(service.list('project-a')[0]?.lastWorktreeLimitAt, undefined)
    assert.equal(service.list('project-a')[0]?.lastWorktreeLimitBlockedBy, undefined)
  })

  it('adopts the durable scheduler task instead of enqueuing one per launch', async () => {
    const scheduleId = 'schedule-1'
    storageSet(STORAGE_KEY, [
      {
        id: scheduleId,
        projectId: 'project-a',
        name: 'Morning review',
        cron: '0 9 * * 1-5',
        prompt: 'Review the current project.',
        model: 'gpt-5.4',
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
      },
    ])
    const supervisor = new FakeTaskSupervisor([
      schedulerTask({ taskId: 'durable-1', projectId: 'project-a', threadId: scheduleId }),
    ])
    const service = createAutomationService({
      now: () => 0,
      isPluginEnabled: () => true,
      createProjectThread: () => Promise.resolve(),
      loadProjectThreads: () => Promise.resolve([]),
      releasePreviousRun: () => Promise.resolve({ released: true }),
      supervisor: () => supervisor,
      getActiveProjectId: () => 'project-a',
    })

    service.start(
      () => {},
      async () => {},
    )
    await service.sync()

    assert.deepEqual(supervisor.enqueued, [])
    assert.deepEqual(supervisor.cancelled, [])
    assert.equal(supervisor.list('project-a').length, 1)
  })

  it('saves a worktree-limit edit without waiting for a scheduler resync', async () => {
    const scheduleId = 'schedule-1'
    storageSet(STORAGE_KEY, [
      {
        id: scheduleId,
        projectId: 'project-a',
        name: 'Morning review',
        cron: '0 9 * * 1-5',
        prompt: 'Review the current project.',
        model: 'gpt-5.4',
        enabled: true,
        maxLiveWorktrees: 1,
        createdAt: 0,
        updatedAt: 0,
      },
    ])
    const supervisor = new FakeTaskSupervisor([
      schedulerTask({ taskId: 'durable-1', projectId: 'project-a', threadId: scheduleId }),
    ])
    const service = createAutomationService({
      now: () => 1,
      isPluginEnabled: () => true,
      createProjectThread: () => Promise.resolve(),
      loadProjectThreads: () => Promise.resolve([]),
      releasePreviousRun: () => Promise.resolve({ released: true }),
      supervisor: () => supervisor,
      getActiveProjectId: () => 'project-a',
    })
    service.start(
      () => {},
      async () => {},
    )
    await service.sync()
    const syncCalls = supervisor.syncCalls

    const input: AutomationScheduleInput = {
      id: scheduleId,
      name: 'Morning review',
      cron: '0 9 * * 1-5',
      prompt: 'Review the current project.',
      model: 'gpt-5.4',
      enabled: true,
      maxLiveWorktrees: 2,
    }
    const updated = await service.upsert('project-a', input)
    assert.equal(updated.maxLiveWorktrees, 2)
    assert.equal(service.list('project-a')[0]?.maxLiveWorktrees, 2)
    assert.equal(supervisor.syncCalls, syncCalls)

    await service.upsert('project-a', { ...input, enabled: false })
    assert.equal(supervisor.syncCalls, syncCalls + 1)
  })

  it('cancels surplus scheduler tasks left by earlier launches', async () => {
    const scheduleId = 'schedule-1'
    storageSet(STORAGE_KEY, [
      {
        id: scheduleId,
        projectId: 'project-a',
        name: 'Morning review',
        cron: '0 9 * * 1-5',
        prompt: 'Review the current project.',
        model: 'gpt-5.4',
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
      },
    ])
    const supervisor = new FakeTaskSupervisor([
      schedulerTask({ taskId: 'durable-1', projectId: 'project-a', threadId: scheduleId }),
      schedulerTask({ taskId: 'durable-2', projectId: 'project-a', threadId: scheduleId }),
    ])
    const service = createAutomationService({
      now: () => 0,
      isPluginEnabled: () => true,
      createProjectThread: () => Promise.resolve(),
      loadProjectThreads: () => Promise.resolve([]),
      releasePreviousRun: () => Promise.resolve({ released: true }),
      supervisor: () => supervisor,
      getActiveProjectId: () => 'project-a',
    })

    service.start(
      () => {},
      async () => {},
    )
    await service.sync()

    assert.deepEqual(supervisor.enqueued, [])
    assert.deepEqual(supervisor.cancelled, ['durable-2'])
    assert.equal(supervisor.list('project-a').filter((task) => task.state === 'waiting').length, 1)
  })

  it('enqueues one scheduler task when none survived on disk', async () => {
    const scheduleId = 'schedule-1'
    storageSet(STORAGE_KEY, [
      {
        id: scheduleId,
        projectId: 'project-a',
        name: 'Morning review',
        cron: '0 9 * * 1-5',
        prompt: 'Review the current project.',
        model: 'gpt-5.4',
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
      },
    ])
    const supervisor = new FakeTaskSupervisor()
    const service = createAutomationService({
      now: () => 0,
      isPluginEnabled: () => true,
      createProjectThread: () => Promise.resolve(),
      loadProjectThreads: () => Promise.resolve([]),
      releasePreviousRun: () => Promise.resolve({ released: true }),
      supervisor: () => supervisor,
      getActiveProjectId: () => 'project-a',
    })

    service.start(
      () => {},
      async () => {},
    )
    await service.sync()
    // A second sync must adopt what the first one enqueued.
    await service.sync()

    assert.equal(supervisor.enqueued.length, 1)
    assert.equal(supervisor.enqueued[0]?.threadId, scheduleId)
    assert.deepEqual(supervisor.cancelled, [])
  })

  it('records a start failure only for the latest run, with a code, and clears it on the next run', async () => {
    storageSet(STORAGE_KEY, [
      {
        id: 'schedule-1',
        projectId: 'project-a',
        name: 'Nightly',
        cron: '* * * * *',
        prompt: 'Go.',
        model: 'gpt-5.4',
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
        lastRunAt: 5,
        lastCreatedThreadId: 'thread-latest',
      },
    ])
    const service = createAutomationService({
      now: () => 100,
      isPluginEnabled: () => true,
      createProjectThread: () => Promise.resolve(),
      loadProjectThreads: () => Promise.resolve([]),
      releasePreviousRun: () => Promise.resolve({ released: true }),
      getActiveProjectId: () => 'project-a',
    })
    assert.equal(
      await service.reportStartFailure('project-a', 'thread-old', {
        code: 'worktree-failed',
        message: 'x',
      }),
      false,
    )
    assert.equal(
      await service.reportStartFailure('project-b', 'thread-latest', {
        code: 'worktree-failed',
        message: 'x',
      }),
      false,
    )
    assert.equal(
      await service.reportStartFailure('project-a', 'thread-latest', {
        code: 'worktree-failed',
        message: 'Isolated worktree is unavailable',
      }),
      true,
    )
    assert.deepEqual(service.list('project-a')[0]?.lastProblem, {
      at: 100,
      kind: 'failed',
      message: 'Isolated worktree is unavailable',
      code: 'worktree-failed',
      threadId: 'thread-latest',
    })
    await service.runNow('project-a', 'schedule-1')
    assert.equal(service.list('project-a')[0]?.lastProblem, undefined)
  })

  describe('scheduler task recovery', () => {
    const SCHEDULE_ID = 'schedule-1'
    function seedSchedule(): void {
      storageSet(STORAGE_KEY, [
        {
          id: SCHEDULE_ID,
          projectId: 'project-a',
          name: 'Morning review',
          cron: '* * * * *',
          prompt: 'Review the current project.',
          model: 'gpt-5.4',
          enabled: true,
          createdAt: 0,
          updatedAt: 0,
        },
      ])
    }
    function serviceFor(
      supervisor: FakeTaskSupervisor,
    ): ReturnType<typeof createAutomationService> {
      return createAutomationService({
        now: () => 0,
        isPluginEnabled: () => true,
        createProjectThread: () => Promise.resolve(),
        loadProjectThreads: () => Promise.resolve([]),
        releasePreviousRun: () => Promise.resolve({ released: true }),
        supervisor: () => supervisor,
        recoveryDelayMs: 0,
        getActiveProjectId: () => 'project-a',
      })
    }
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))

    it('replaces a scheduler task left blocked by an interrupted restart', async () => {
      seedSchedule()
      const supervisor = new FakeTaskSupervisor([
        {
          ...schedulerTask({ taskId: 'stale', projectId: 'project-a', threadId: SCHEDULE_ID }),
          state: 'blocked',
        },
      ])
      const service = serviceFor(supervisor)

      service.start(
        () => {},
        async () => {},
      )
      await service.sync()
      service.stop()

      assert.deepEqual(supervisor.cancelled, ['stale'])
      assert.equal(supervisor.enqueued.length, 1)
    })

    it('replaces a scheduler task that fails while the app is running', async () => {
      seedSchedule()
      const supervisor = new FakeTaskSupervisor([
        schedulerTask({ taskId: 'live', projectId: 'project-a', threadId: SCHEDULE_ID }),
      ])
      const service = serviceFor(supervisor)
      service.start(
        () => {},
        async () => {},
      )
      await service.sync()
      assert.equal(supervisor.enqueued.length, 0)

      supervisor.setState('live', 'failed')
      await settle()
      service.stop()

      assert.equal(supervisor.enqueued.length, 1)
    })

    it('does not replace the scheduler task more than once for a burst of failures', async () => {
      seedSchedule()
      const supervisor = new FakeTaskSupervisor([
        schedulerTask({ taskId: 'live', projectId: 'project-a', threadId: SCHEDULE_ID }),
      ])
      const service = serviceFor(supervisor)
      service.start(
        () => {},
        async () => {},
      )
      await service.sync()

      supervisor.setState('live', 'blocked')
      supervisor.setState('live', 'failed')
      await settle()
      service.stop()

      assert.equal(supervisor.enqueued.length, 1)
    })

    it('reports the scheduler as recovering, then healthy once a replacement is running', async () => {
      seedSchedule()
      const supervisor = new FakeTaskSupervisor([
        schedulerTask({ taskId: 'live', projectId: 'project-a', threadId: SCHEDULE_ID }),
      ])
      const service = serviceFor(supervisor)
      const seen: string[] = []
      service.onHealthChange((health) => seen.push(`${health.state}:${health.message ?? ''}`))
      service.start(
        () => {},
        async () => {},
      )
      await service.sync()
      assert.equal(service.health().state, 'ok')

      supervisor.setState('live', 'failed')
      assert.equal(service.health().state, 'recovering')
      assert.ok(service.health().since !== null)
      await settle()
      service.stop()

      assert.deepEqual(
        seen.map((entry) => entry.split(':')[0]),
        ['recovering', 'ok'],
      )
      assert.equal(service.health().state, 'ok')
      assert.equal(service.health().since, null)
    })

    it('reports the scheduler as stopped when its replacement cannot be created', async () => {
      seedSchedule()
      const supervisor = new FakeTaskSupervisor([
        schedulerTask({ taskId: 'live', projectId: 'project-a', threadId: SCHEDULE_ID }),
      ])
      supervisor.enqueue = (): Promise<SupervisedTaskMeta> =>
        Promise.reject(new Error('disk is full'))
      const service = serviceFor(supervisor)
      service.start(
        () => {},
        async () => {},
      )
      await service.sync()

      supervisor.setState('live', 'failed')
      await settle()
      service.stop()

      assert.equal(service.health().state, 'stopped')
      assert.match(service.health().message ?? '', /disk is full/)
    })

    it('stops reacting to the supervisor once stopped', async () => {
      seedSchedule()
      const supervisor = new FakeTaskSupervisor([
        schedulerTask({ taskId: 'live', projectId: 'project-a', threadId: SCHEDULE_ID }),
      ])
      const service = serviceFor(supervisor)
      service.start(
        () => {},
        async () => {},
      )
      await service.sync()
      service.stop()

      supervisor.setState('live', 'failed')
      await settle()

      assert.equal(supervisor.enqueued.length, 0)
    })

    it('enqueues a scheduler task that survives an interrupted tick and has room to finish', async () => {
      seedSchedule()
      const supervisor = new FakeTaskSupervisor()
      const service = serviceFor(supervisor)

      service.start(
        () => {},
        async () => {},
      )
      await service.sync()
      service.stop()

      const [input] = supervisor.enqueued
      assert.ok(input)
      assert.equal(input.restartPolicy, 'retry')
      assert.ok(input.maxAttempts > 1, 'a requeued tick keeps its attempt count')
      assert.ok((input.resourceBudget?.maxDurationMs ?? 0) >= 120_000)
    })
  })

  it('triggers schedules due in the same minute together, so a slow one cannot starve the rest', async () => {
    storageSet(
      STORAGE_KEY,
      ['a', 'b', 'c'].map((id) => ({
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
    // Every thread creation waits until all three have begun. A sequential tick
    // would never get the second one started, and the guard below would fire.
    const begun: string[] = []
    let openBarrier: () => void = () => {}
    const barrier = new Promise<void>((resolve) => {
      openBarrier = resolve
    })
    const service = createAutomationService({
      now: () => new Date(2026, 6, 27, 9, 0, 5).getTime(),
      isPluginEnabled: () => true,
      createProjectThread: async (_projectId, thread) => {
        begun.push(thread.title)
        if (begun.length === 3) openBarrier()
        await barrier
      },
      loadProjectThreads: () => Promise.resolve([]),
      releasePreviousRun: () => Promise.resolve({ released: true }),
      getActiveProjectId: () => 'project-a',
    })

    const outcome = await Promise.race([
      service.tick().then(() => 'done'),
      new Promise<string>((resolve) => {
        setTimeout(() => {
          resolve('serialised')
        }, 500)
      }),
    ])

    assert.equal(outcome, 'done')
    assert.deepEqual(begun.sort(), ['a', 'b', 'c'])
  })

  it('isolates a trigger that hangs instead of letting it block the tick past its own timeout', async (context) => {
    context.mock.method(console, 'error', () => {})
    context.mock.timers.enable({ apis: ['setTimeout'] })
    storageSet(STORAGE_KEY, [
      {
        id: 'stuck',
        projectId: 'project-a',
        name: 'stuck',
        cron: '* * * * *',
        prompt: 'p',
        model: 'm',
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
      },
    ])
    let now = new Date(2026, 6, 27, 9, 0, 5).getTime()
    let attempts = 0
    const service = createAutomationService({
      now: () => now,
      isPluginEnabled: () => true,
      // Only the first attempt is permanently stuck. Later cron occurrences
      // must remain eligible without waiting for it to resolve.
      createProjectThread: () => {
        attempts += 1
        return attempts === 1 ? new Promise<void>(() => {}) : Promise.resolve()
      },
      loadProjectThreads: () => Promise.resolve([]),
      releasePreviousRun: () => Promise.resolve({ released: true }),
    })

    const pending = service.tick()
    // Let the hung trigger actually start before advancing past its timeout.
    for (let i = 0; i < 5; i++) await Promise.resolve()
    context.mock.timers.tick(SCHEDULER_TRIGGER_TIMEOUT_MS)
    await pending

    const problem = service.list('project-a')[0]?.lastProblem
    assert.equal(problem?.kind, 'failed')
    assert.match(problem.message, /timed out/)
    now += 60_000
    await service.tick()
    assert.equal(attempts, 2)
    assert.equal(service.list('project-a')[0]?.lastRunAt, now)
  })

  it('retries after timeout and fences a late creation from the replacement run', async (context) => {
    context.mock.method(console, 'error', () => {})
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const previousRoot = process.env['COPSE_WORKSPACE_DIR']
    const root = mkdtempSync(join(tmpdir(), 'automation-timeout-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
    context.after(() => {
      if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
      else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
      rmSync(root, { recursive: true, force: true })
    })
    let oldThreadId = ''
    let now = new Date(2026, 6, 27, 9, 0, 5).getTime()
    let resolveOld: () => void = () => {}
    let resolveNext: () => void = () => {}
    let creations = 0
    const events: AutomationTriggerEvent[] = []
    const service = createAutomationService({
      now: () => now,
      isPluginEnabled: () => true,
      createProjectThread: async (projectId, thread) => {
        creations += 1
        if (creations === 1) oldThreadId = thread.id
        await new Promise<void>((resolve) => {
          if (creations === 1) resolveOld = resolve
          else resolveNext = resolve
        })
        await createThread(projectId, thread)
      },
      loadProjectThreads: () => Promise.resolve([]),
      releasePreviousRun: () => Promise.resolve({ released: true }),
      supervisor: () => new FakeTaskSupervisor(),
    })
    service.start((event) => events.push(event))
    const schedule = await service.upsert('project-a', {
      name: 'retry',
      cron: '* * * * *',
      prompt: 'p',
      model: 'm',
      enabled: true,
    })
    const first = service.tick()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    assert.equal(creations, 1)
    context.mock.timers.tick(SCHEDULER_TRIGGER_TIMEOUT_MS)
    await first
    now += 60_000
    const replacement = service.runNow('project-a', schedule.id)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    assert.equal(creations, 2)
    resolveOld()
    const deadline = Date.now() + 5_000
    while (
      (await getThreadMeta('project-a', oldThreadId))?.automation?.startFailedAt === undefined
    ) {
      if (Date.now() > deadline) throw new Error('Late thread was not marked failed')
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    assert.equal((await getThreadMeta('project-a', oldThreadId))?.draftPrompt, 'p')
    // Let the old trigger's finally execute after its durable failure write.
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(events.length, 0)
    assert.equal(service.list('project-a')[0]?.lastCreatedThreadId, undefined)
    await assert.rejects(service.runNow('project-a', schedule.id), /already creating/)
    resolveNext()
    const event = await replacement
    assert.equal(events.length, 1)
    assert.equal(service.list('project-a')[0]?.lastCreatedThreadId, event.threadId)
    service.stop()
  })

  it('removes a late-created run whose failed-start marker cannot be written', async (context) => {
    context.mock.method(console, 'error', () => {})
    const warnings = context.mock.method(console, 'warn', () => {})
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const now = new Date(2026, 6, 27, 9, 0, 5).getTime()
    let resolveCreate: () => void = () => {}
    const threads = new Map<string, Thread>()
    const deleted: string[] = []
    const events: AutomationTriggerEvent[] = []
    const service = createAutomationService({
      now: () => now,
      isPluginEnabled: () => true,
      createProjectThread: async (_projectId, thread) => {
        await new Promise<void>((resolve) => {
          resolveCreate = resolve
        })
        threads.set(thread.id, thread)
      },
      updateProjectThreadMeta: () => Promise.reject(new Error('disk full')),
      deleteProjectThread: (_projectId, threadId) => {
        deleted.push(threadId)
        threads.delete(threadId)
        return Promise.resolve()
      },
      loadProjectThreads: () => Promise.resolve([...threads.values()]),
      releasePreviousRun: () => Promise.resolve({ released: true }),
      supervisor: () => new FakeTaskSupervisor(),
    })
    service.start((event) => events.push(event))
    await service.upsert('project-a', {
      name: 'late',
      cron: '* * * * *',
      prompt: 'p',
      model: 'm',
      enabled: true,
    })
    const tick = service.tick()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    context.mock.timers.tick(SCHEDULER_TRIGGER_TIMEOUT_MS)
    await tick

    // The filesystem work finishes after the deadline, then the marker write fails.
    resolveCreate()
    const deadline = Date.now() + 5_000
    while (deleted.length === 0) {
      if (Date.now() > deadline) throw new Error('Unmarked late run was not removed')
      await new Promise<void>((resolve) => setImmediate(resolve))
    }

    assert.equal(deleted.length, 1)
    assert.equal(threads.size, 0, 'no idle draft is left for the renderer to auto-start')
    assert.equal(warnings.mock.callCount(), 1)
    assert.equal(events.length, 0)
    assert.equal(service.list('project-a')[0]?.lastCreatedThreadId, undefined)
    service.stop()
  })

  describe('trigger problems the user can see', () => {
    function harness(): {
      threads: Map<string, Thread>
      service: ReturnType<typeof createAutomationService>
      setNow: (value: number) => void
      failNextCreate: (message: string) => void
    } {
      let now = new Date(2026, 6, 27, 9, 0, 0).getTime()
      let failure: string | null = null
      const threads = new Map<string, Thread>()
      const service = createAutomationService({
        now: () => now,
        isPluginEnabled: () => true,
        createProjectThread: (_projectId, thread) => {
          if (failure !== null) {
            const message = failure
            failure = null
            return Promise.reject(new Error(message))
          }
          threads.set(thread.id, thread)
          return Promise.resolve()
        },
        loadProjectThreads: () => Promise.resolve([...threads.values()]),
        releasePreviousRun: () => Promise.resolve({ released: true }),
        getActiveProjectId: () => 'project-a',
      })
      return {
        threads,
        service,
        setNow: (value: number): void => {
          now = value
        },
        failNextCreate: (message: string): void => {
          failure = message
        },
      }
    }
    const input = {
      name: 'Project health',
      cron: '* * * * *',
      prompt: 'Check project health.',
      model: 'gpt-5.4',
      enabled: true,
    }

    it('keeps a failed start from blocking the next run', async () => {
      const { threads, service, setNow } = harness()
      const schedule = await service.upsert('project-a', input)
      const first = await service.runNow('project-a', schedule.id)
      const stuck = threads.get(first.threadId)
      assert.ok(stuck?.automation)
      // The renderer could not start it: the draft is kept, marked as failed.
      threads.set(first.threadId, {
        ...stuck,
        automation: { ...stuck.automation, startFailedAt: 1 },
      })

      setNow(new Date(2026, 6, 27, 9, 1, 0).getTime())
      const next = await service.runNow('project-a', schedule.id)

      assert.equal(next.disposition, 'started')
      assert.notEqual(next.threadId, first.threadId)
      assert.equal(threads.size, 2)
    })

    it('records a skipped run behind an unstarted draft, and clears it once a run starts', async () => {
      const { threads, service, setNow } = harness()
      const schedule = await service.upsert('project-a', input)
      const first = await service.runNow('project-a', schedule.id)
      const triggeredAt = new Date(2026, 6, 27, 9, 1, 0).getTime()

      setNow(triggeredAt)
      const skipped = await service.runNow('project-a', schedule.id)
      assert.equal(skipped.disposition, 'coalesced')
      const problem = service.list('project-a')[0]?.lastProblem
      assert.equal(problem?.kind, 'pending-start')
      assert.equal(problem.at, triggeredAt)
      assert.match(problem.message, /never started/)

      const pending = threads.get(first.threadId)
      assert.ok(pending)
      threads.set(first.threadId, { ...pending, draftPrompt: '' })
      setNow(new Date(2026, 6, 27, 9, 2, 0).getTime())
      const started = await service.runNow('project-a', schedule.id)
      assert.equal(started.disposition, 'started')
      assert.equal(service.list('project-a')[0]?.lastProblem, undefined)
    })

    it('does not report a run that is simply still going as a problem', async () => {
      const { threads, service } = harness()
      const schedule = await service.upsert('project-a', input)
      const first = await service.runNow('project-a', schedule.id)
      const pending = threads.get(first.threadId)
      assert.ok(pending)
      threads.set(first.threadId, { ...pending, status: 'running', draftPrompt: '' })

      const overlap = await service.runNow('project-a', schedule.id)

      assert.equal(overlap.disposition, 'coalesced')
      assert.equal(service.list('project-a')[0]?.lastProblem, undefined)
    })

    it('records a tick that failed to create its task, and clears it after a good run', async (context) => {
      context.mock.method(console, 'error', () => {})
      const { service, failNextCreate, setNow } = harness()
      const schedule = await service.upsert('project-a', input)
      failNextCreate('disk unavailable')

      await service.tick()
      const problem = service.list('project-a')[0]?.lastProblem
      assert.equal(problem?.kind, 'failed')
      assert.equal(problem.message, 'disk unavailable')

      setNow(new Date(2026, 6, 27, 9, 1, 0).getTime())
      await service.tick()
      assert.equal(service.list('project-a')[0]?.lastProblem, undefined)
      assert.equal(service.list('project-a')[0]?.id, schedule.id)
    })

    it('keeps the problem when the schedule is edited', async (context) => {
      context.mock.method(console, 'error', () => {})
      const { service, failNextCreate } = harness()
      const schedule = await service.upsert('project-a', input)
      failNextCreate('disk unavailable')
      await service.tick()

      await service.upsert('project-a', { ...input, id: schedule.id, name: 'Renamed' })

      assert.equal(service.list('project-a')[0]?.lastProblem?.message, 'disk unavailable')
    })
  })
  it('keeps a schedule this version cannot read when other schedules change', async () => {
    const newer = {
      id: 'from-a-newer-build',
      projectId: 'project-a',
      name: 'Newer',
      cron: '0 9 * * *',
      prompt: 'p',
      model: 'm',
      enabled: true,
      permissions: [{ kind: 'a-kind-added-later', toolName: 'x' }],
      createdAt: 0,
      updatedAt: 0,
    }
    storageSet(STORAGE_KEY, [newer])
    const service = createAutomationService({
      now: () => 1,
      isPluginEnabled: () => true,
      createProjectThread: () => Promise.resolve(),
      loadProjectThreads: () => Promise.resolve([]),
      releasePreviousRun: () => Promise.resolve({ released: true }),
      getActiveProjectId: () => 'project-a',
    })

    const mine = await service.upsert('project-a', {
      name: 'Mine',
      cron: '* * * * *',
      prompt: 'p',
      model: 'm',
      enabled: true,
    })
    await service.runNow('project-a', mine.id)
    await service.upsert('project-a', { ...mine, name: 'Mine, renamed' })
    await service.remove('project-a', mine.id)

    assert.deepEqual(storageGet(STORAGE_KEY), [newer])
  })
  describe('a timer that fires after its minute', () => {
    const NINE = new Date(2026, 6, 27, 9, 0, 0).getTime()
    function setup(clock: number): {
      created: Thread[]
      service: ReturnType<typeof createAutomationService>
      supervisor: FakeTaskSupervisor
    } {
      const created: Thread[] = []
      const supervisor = new FakeTaskSupervisor()
      storageSet(STORAGE_KEY, [
        {
          id: 'nine',
          projectId: 'project-a',
          name: 'Nine',
          cron: '0 9 * * *',
          prompt: 'p',
          model: 'm',
          enabled: true,
          createdAt: 0,
          updatedAt: 0,
        },
      ])
      const service = createAutomationService({
        now: () => clock,
        isPluginEnabled: () => true,
        createProjectThread: (_projectId, thread) => {
          created.push(thread)
          return Promise.resolve()
        },
        loadProjectThreads: () => Promise.resolve(created),
        releasePreviousRun: () => Promise.resolve({ released: true }),
        supervisor: () => supervisor,
        getActiveProjectId: () => 'project-a',
      })
      return { created, service, supervisor }
    }

    it('still runs the minute it was armed for', async () => {
      const { created, service } = setup(NINE + 70_000)
      await service.tick(NINE)
      assert.equal(created.length, 1)
      assert.equal(created[0]?.automation?.triggeredAt, NINE)
    })

    it('does not run a minute it was not armed for', async () => {
      const { created, service } = setup(NINE + 70_000)
      await service.tick()
      assert.equal(created.length, 0)
    })

    it('does not catch up on a wake that is too stale to be a late timer', async () => {
      const { created, service } = setup(NINE + 10 * 60_000)
      await service.tick(NINE)
      assert.equal(created.length, 0)
    })

    it('takes the armed minute from the supervisor task that woke the scheduler', async () => {
      const { created, service, supervisor } = setup(NINE + 70_000)
      service.start(
        () => {},
        async () => {},
      )
      const task = {
        ...schedulerTask({ taskId: 't', projectId: 'project-a', threadId: 'nine' }),
        nextWakeAt: NINE,
      }
      await supervisor.handler?.(task, { signal: new AbortController().signal })
      service.stop()
      assert.equal(created.length, 1)
    })
  })

  describe('running an unfocused schedule headlessly', () => {
    let root: string
    let previousRoot: string | undefined

    beforeEach(() => {
      previousRoot = process.env['COPSE_WORKSPACE_DIR']
      root = mkdtempSync(join(tmpdir(), 'copse-automation-headless-'))
      process.env['COPSE_WORKSPACE_DIR'] = root
    })

    afterEach(() => {
      if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
      else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
      rmSync(root, { recursive: true, force: true })
    })

    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

    // The headless turn is fire-and-forget from `trigger()`, so a fixed sleep
    // races it on a loaded machine (and lets `afterEach` delete the store under
    // a turn that is still writing). Poll until it has actually finished.
    async function waitForHeadlessTurn(
      dispatchCalls: AgentDispatchRequest[],
      projectId: string,
      threadId: string,
    ): Promise<void> {
      const deadline = Date.now() + 5_000
      while (
        dispatchCalls.length === 0 ||
        (await getThreadMeta(projectId, threadId))?.status === 'running'
      ) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for the headless turn')
        await settle()
      }
    }

    function harness(
      activeProjectId: string | null,
      checkoutError?: Error,
      beforeDone?: (request: AgentDispatchRequest) => Promise<void>,
    ): {
      service: ReturnType<typeof createAutomationService>
      dispatchCalls: AgentDispatchRequest[]
      events: AutomationTriggerEvent[]
    } {
      const dispatchCalls: AgentDispatchRequest[] = []
      const events: AutomationTriggerEvent[] = []
      const dispatch: DispatchHeadlessTurn = async (request, host) => {
        dispatchCalls.push(request)
        await beforeDone?.(request)
        host.emit(request.threadId, { type: 'done' } satisfies StreamChunk)
      }
      // `createProjectThread` is the real on-disk writer here (the same
      // function production wires up), so the headless turn's own direct
      // `updateMetaOrThrow`/`appendMessage` calls against `../thread-store.ts`
      // land against a real, freshly-created thread instead of throwing
      // "Thread is not persisted yet".
      const service = createAutomationService({
        now: () => Date.now(),
        isPluginEnabled: () => true,
        createProjectThread: createThread,
        loadProjectThreads: () => Promise.resolve([]),
        releasePreviousRun: () => Promise.resolve({ released: true }),
        getActiveProjectId: () => activeProjectId,
        prepareCheckout: async (input) => {
          assert.equal(input.choice, 'worktree')
          assert.equal(input.projectId, 'project-a')
          assert.equal(dispatchCalls.length, 0)
          const thread = await getThreadMeta(input.projectId, input.threadId)
          assert.equal(thread?.draftPrompt, input.prompt)
          assert.equal(thread.status, 'idle')
          if (checkoutError) throw checkoutError
          return { checkoutMode: 'worktree', choice: 'worktree', branch: 'copse/test' }
        },
        supervisor: () => new FakeTaskSupervisor(),
      })
      service.start((event) => events.push(event), dispatch)
      return { service, dispatchCalls, events }
    }

    it('dispatches the first turn from main and lands the thread back on idle', async () => {
      const { service, dispatchCalls, events } = harness('project-b')
      const schedule = await service.upsert('project-a', {
        name: 'Project health',
        cron: '* * * * *',
        prompt: 'Check project health.',
        model: 'gpt-5.4',
        enabled: true,
      })

      const event = await service.runNow('project-a', schedule.id)
      await waitForHeadlessTurn(dispatchCalls, 'project-a', event.threadId)

      assert.equal(dispatchCalls.length, 1)
      assert.equal(dispatchCalls[0]?.projectId, 'project-a')
      assert.equal(dispatchCalls[0].threadId, event.threadId)
      assert.equal(dispatchCalls[0].payload.userContent, 'Check project health.')

      const meta = await getThreadMeta('project-a', event.threadId)
      assert.equal(meta?.status, 'idle')
      assert.equal(events.length, 2)
      assert.equal(events[0]?.headlessSettled, undefined)
      assert.equal(events[1]?.headlessSettled, true)
    })

    it('does not finalize or notify a headless run after a newer root takes ownership', async () => {
      let acknowledgeReplacement: () => void = () => {}
      const replacementWritten = new Promise<void>((resolve) => {
        acknowledgeReplacement = resolve
      })
      const { service, dispatchCalls, events } = harness(
        'project-b',
        undefined,
        async (request) => {
          await updateMetaOrThrow(request.projectId, request.threadId, {
            currentEpoch: 'newer-interactive-root',
            status: 'running',
            title: 'New user title',
          })
          acknowledgeReplacement()
        },
      )
      const schedule = await service.upsert('project-a', {
        name: 'Project health',
        cron: '* * * * *',
        prompt: 'Check project health.',
        model: 'gpt-5.4',
        enabled: true,
      })
      const event = await service.runNow('project-a', schedule.id)
      await replacementWritten
      // Let the already-settled dispatch and its cached metadata checks run;
      // no provider or filesystem operation remains outstanding.
      await settle()
      await settle()
      const current = await getThreadMeta('project-a', event.threadId)
      assert.equal(current?.currentEpoch, 'newer-interactive-root')
      assert.equal(current.status, 'running')
      assert.equal(current.title, 'New user title')
      assert.equal(dispatchCalls.length, 1)
      assert.equal(events.length, 1)
      assert.equal(events[0]?.headlessSettled, undefined)
      service.stop()
    })

    it('preserves an unsent failed-start draft and never dispatches when checkout fails', async (context) => {
      context.mock.method(console, 'error', () => {})
      const { service, dispatchCalls } = harness('project-b', new Error('checkout unavailable'))
      const schedule = await service.upsert('project-a', {
        name: 'Project health',
        cron: '* * * * *',
        prompt: 'Check project health.',
        model: 'gpt-5.4',
        enabled: true,
      })
      const event = await service.runNow('project-a', schedule.id)
      const deadline = Date.now() + 5_000
      while (
        (await getThreadMeta('project-a', event.threadId))?.automation?.startFailedAt === undefined
      ) {
        if (Date.now() > deadline) throw new Error('Checkout failure was not recorded')
        await settle()
      }
      assert.equal(dispatchCalls.length, 0)
      const thread = await getThreadMeta('project-a', event.threadId)
      assert.equal(thread?.draftPrompt, 'Check project health.')
      assert.equal(service.list('project-a')[0]?.lastProblem?.code, 'worktree-failed')
      service.stop()
    })

    it('leaves the turn to the renderer when the schedule project is already focused', async () => {
      const { service, dispatchCalls } = harness('project-a')
      const schedule = await service.upsert('project-a', {
        name: 'Project health',
        cron: '* * * * *',
        prompt: 'Check project health.',
        model: 'gpt-5.4',
        enabled: true,
      })

      await service.runNow('project-a', schedule.id)
      await settle()

      assert.equal(dispatchCalls.length, 0)
    })
  })
})
