import '../../../tests/setup-dom.ts'
import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { AutomationSchedule, AutomationScheduleInput } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { BEST_VALUE_CHAT_MODEL } from '@shared/lm-studio-defaults.ts'
import { createAutomationPluginSettings } from './automation-plugin-settings.ts'
import type { ModelOptionsApi } from './model-options.ts'

type AutomationSettingsApi = ModelOptionsApi & Pick<ApiClient, 'automations'>

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function stubApi(schedules: AutomationSchedule[]): {
  api: AutomationSettingsApi
  upserts: Array<{ projectId: string; input: AutomationScheduleInput }>
} {
  const upserts: Array<{ projectId: string; input: AutomationScheduleInput }> = []
  const api: AutomationSettingsApi = {
    automations: {
      list(projectId: string): Promise<AutomationSchedule[]> {
        return Promise.resolve(schedules.filter((schedule) => schedule.projectId === projectId))
      },
      upsert(projectId: string, input: AutomationScheduleInput): Promise<AutomationSchedule> {
        upserts.push({ projectId, input })
        return Promise.resolve({
          id: input.id ?? 'created-schedule',
          projectId,
          name: input.name,
          cron: input.cron,
          prompt: input.prompt,
          model: input.model,
          enabled: input.enabled,
          createdAt: 1,
          updatedAt: 1,
        })
      },
      remove(): Promise<void> {
        return Promise.resolve()
      },
      runNow(): Promise<{
        projectId: string
        scheduleId: string
        threadId: string
        triggeredAt: number
      }> {
        return Promise.resolve({
          projectId: 'project-a',
          scheduleId: 'schedule-a',
          threadId: 'thread-a',
          triggeredAt: 1,
        })
      },
      onTriggered(): () => void {
        return (): void => {}
      },
    },
    settings: {
      availableProviders(): Promise<{ openai: boolean }> {
        return Promise.resolve({ openai: true })
      },
      extraProviders(): Promise<[]> {
        return Promise.resolve([])
      },
      get(): Promise<null> {
        return Promise.resolve(null)
      },
    },
    lmStudio: {
      models(): Promise<string[]> {
        return Promise.resolve([])
      },
    },
    openRouter: {
      models(): Promise<[]> {
        return Promise.resolve([])
      },
    },
    remoteAgent: {
      models(): Promise<[]> {
        return Promise.resolve([])
      },
    },
  }
  return { api, upserts }
}

describe('automation plugin settings detail', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('shows only the active project schedules and disables Run now with the plugin off', async () => {
    const schedule: AutomationSchedule = {
      id: 'schedule-a',
      projectId: 'project-a',
      name: 'Morning review',
      cron: '0 9 * * 1-5',
      prompt: 'Review the project.',
      model: 'gpt-5.4',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    }
    const { api } = stubApi([
      schedule,
      { ...schedule, id: 'schedule-b', projectId: 'project-b', name: 'Other project' },
    ])
    const store = createStore({
      activeProjectId: 'project-a',
      projects: [{ id: 'project-a', path: '/repo/a', name: 'Project A' }],
      settings: { model: 'gpt-5.4' },
    })
    const root = createAutomationPluginSettings(store, api, false)
    document.body.append(root)
    await tick()

    assert.match(root.textContent, /Project: Project A/)
    assert.match(root.textContent, /Morning review/)
    assert.doesNotMatch(root.textContent, /Other project/)
    const runButton = root.querySelector<HTMLButtonElement>('.automation-run-btn')
    assert.ok(runButton)
    assert.equal(runButton.disabled, true)
  })

  it('submits a project-scoped schedule with the selected model rule', async () => {
    const { api, upserts } = stubApi([])
    const store = createStore({
      activeProjectId: 'project-a',
      projects: [{ id: 'project-a', path: '/repo/a', name: 'Project A' }],
      settings: { model: 'gpt-5.4' },
    })
    const root = createAutomationPluginSettings(store, api, true)
    document.body.append(root)
    root.querySelector<HTMLButtonElement>('.automation-add-btn')?.click()
    await tick()

    // A schedule stores a rule, not a model id: it fires unattended, long after
    // this form was filled in, so it must not inherit "whatever chat model I
    // happen to be on right now" (gpt-5.4 in this store).
    assert.match(
      root.querySelector('.automation-form .model-picker-label')?.textContent ?? '',
      /^Best value/,
    )
    assert.ok(root.querySelector('.automation-form .model-picker-filter'))
    const name = root.querySelector<HTMLInputElement>('.automation-name-input')
    const cron = root.querySelector<HTMLInputElement>('.automation-cron-input')
    const prompt = root.querySelector<HTMLTextAreaElement>('.automation-prompt-input')
    const form = root.querySelector<HTMLFormElement>('.automation-form')
    assert.ok(name && cron && prompt && form)
    name.value = 'Nightly review'
    cron.value = '0 21 * * *'
    prompt.value = 'Review the diff.'
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()

    assert.deepEqual(upserts, [
      {
        projectId: 'project-a',
        input: {
          name: 'Nightly review',
          cron: '0 21 * * *',
          prompt: 'Review the diff.',
          model: BEST_VALUE_CHAT_MODEL,
          enabled: true,
        },
      },
    ])
  })

  it('keeps editing a schedule that still pins a concrete model', async () => {
    // Schedules written before dynamic selection stay exactly as saved — the
    // picker surfaces the pinned id rather than silently swapping in a rule.
    const schedule: AutomationSchedule = {
      id: 'schedule-a',
      projectId: 'project-a',
      name: 'Morning review',
      cron: '0 9 * * 1-5',
      prompt: 'Review the project.',
      model: 'gpt-5.4',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    }
    const { api, upserts } = stubApi([schedule])
    const store = createStore({
      activeProjectId: 'project-a',
      projects: [{ id: 'project-a', path: '/repo/a', name: 'Project A' }],
    })
    const root = createAutomationPluginSettings(store, api, true)
    document.body.append(root)
    await tick()
    root.querySelector<HTMLButtonElement>('.automation-row-btn')?.click()
    await tick()

    assert.match(
      root.querySelector('.automation-form .model-picker-label')?.textContent ?? '',
      /pinned/i,
    )
    root
      .querySelector<HTMLFormElement>('.automation-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()
    assert.equal(upserts[0]?.input.model, 'gpt-5.4')
  })
})
