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
})
