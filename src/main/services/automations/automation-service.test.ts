import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AUTOMATIONS_PLUGIN_ID } from '@copse/agent/plugins/automations-plugin.ts'
import type { Thread } from '@shared/types'
import { storageSet } from '../storage/storage.ts'
import { createAutomationService } from './automation-service.ts'

const STORAGE_KEY = `pack.${AUTOMATIONS_PLUGIN_ID}.storage`

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
      releasePreviousRun: () => Promise.resolve(true),
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
      releasePreviousRun: () => Promise.resolve(true),
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
      releasePreviousRun: () => Promise.resolve(true),
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
      releasePreviousRun: () => Promise.resolve(true),
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
      isPackEnabled: () => true,
      createProjectThread: (_projectId, thread) => {
        threads.set(thread.id, thread)
        return Promise.resolve()
      },
      loadProjectThreads: () => Promise.resolve([...threads.values()]),
      releasePreviousRun: () => Promise.resolve(true),
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

  it('does not allocate another worktree while the previous run retains changes', async () => {
    let now = new Date(2026, 6, 27, 9, 0, 0).getTime()
    const threads = new Map<string, Thread>()
    const service = createAutomationService({
      now: () => now,
      isPackEnabled: () => true,
      createProjectThread: (_projectId, thread) => {
        threads.set(thread.id, thread)
        return Promise.resolve()
      },
      loadProjectThreads: () => Promise.resolve([...threads.values()]),
      releasePreviousRun: () => Promise.resolve(false),
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
    const blocked = await service.runNow('project-a', schedule.id)
    assert.equal(blocked.disposition, 'coalesced')
    assert.equal(blocked.coalescedReason, 'worktree-limit')
    assert.equal(blocked.threadId, first.threadId)
    assert.equal(threads.size, 1)
  })

  it('allows a bounded number of retained worktrees when the schedule opts in', async () => {
    let now = new Date(2026, 6, 27, 9, 0, 0).getTime()
    const threads = new Map<string, Thread>()
    const service = createAutomationService({
      now: () => now,
      isPackEnabled: () => true,
      createProjectThread: (_projectId, thread) => {
        threads.set(thread.id, thread)
        return Promise.resolve()
      },
      loadProjectThreads: () => Promise.resolve([...threads.values()]),
      releasePreviousRun: () => Promise.resolve(false),
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
    const second = await service.runNow('project-a', schedule.id)
    assert.equal(second.disposition, 'started')
    assert.notEqual(second.threadId, first.threadId)

    attachWorktree(second.threadId)
    now += 60_000
    const third = await service.runNow('project-a', schedule.id)
    assert.equal(third.disposition, 'coalesced')
    assert.equal(third.coalescedReason, 'worktree-limit')
    assert.equal(threads.size, 2)
  })
})
