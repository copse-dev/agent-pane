import '../../../tests/setup-dom.ts'
import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type {
  AutomationPermissionOption,
  AutomationSchedule,
  AutomationScheduleInput,
  AutomationTriggerEvent,
  BranchCiAutomation,
  BranchCiAutomationInput,
  EventDeliverySummary,
  EventMatchPreview,
} from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { BEST_VALUE_CHAT_MODEL } from '@shared/lm-studio-defaults.ts'
import { createAutomationPluginSettings } from './automation-plugin-settings.ts'
import type { ModelOptionsApi } from './model-options.ts'

type AutomationSettingsApi = ModelOptionsApi & Pick<ApiClient, 'automations'>

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

const PERMISSION_OPTIONS: AutomationPermissionOption[] = [
  {
    permission: { kind: 'copse-action', toolName: 'gh_pr_approve' },
    label: 'Approve pull requests',
    detail: 'Submits a GitHub approval for this project.',
  },
  {
    permission: { kind: 'mcp-tool', toolName: 'mcp__linear__create_issue' },
    label: 'Create issue',
    detail: 'linear MCP server · may access external systems',
  },
]

function stubApi(
  schedules: AutomationSchedule[],
  permissionOptions: AutomationPermissionOption[] = PERMISSION_OPTIONS,
): {
  api: AutomationSettingsApi
  upserts: Array<{ projectId: string; input: AutomationScheduleInput }>
  emitTriggered: (event: AutomationTriggerEvent) => void
} {
  const upserts: Array<{ projectId: string; input: AutomationScheduleInput }> = []
  const triggerHandlers = new Set<(event: AutomationTriggerEvent) => void>()
  const api: AutomationSettingsApi = {
    automations: {
      list(projectId: string): Promise<AutomationSchedule[]> {
        return Promise.resolve(schedules.filter((schedule) => schedule.projectId === projectId))
      },
      permissionOptions(): Promise<AutomationPermissionOption[]> {
        return Promise.resolve(permissionOptions)
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
          ...(input.maxLiveWorktrees !== undefined
            ? { maxLiveWorktrees: input.maxLiveWorktrees }
            : {}),
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
        disposition: 'started'
      }> {
        return Promise.resolve({
          projectId: 'project-a',
          scheduleId: 'schedule-a',
          threadId: 'thread-a',
          triggeredAt: 1,
          disposition: 'started',
        })
      },
      listBranchCi: () => Promise.resolve([]),
      upsertBranchCi: () => Promise.reject(new Error('Not configured in this test')),
      removeBranchCi: () => Promise.resolve(),
      testBranchCi: () =>
        Promise.resolve({
          repository: 'github.com/owner/repo',
          branch: 'main',
          latestFailure: null,
          recent: [],
        }),
      eventHistory: () => Promise.resolve([]),
      reportStartFailure: () => Promise.resolve(false),
      schedulerHealth: () => Promise.resolve({ state: 'ok', since: null, message: null }),
      onSchedulerHealth: () => () => {},
      canStart: () => Promise.resolve({ allowed: true }),
      onTriggered(handler): () => void {
        triggerHandlers.add(handler)
        return (): void => {
          triggerHandlers.delete(handler)
        }
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
  return {
    api,
    upserts,
    emitTriggered(event): void {
      triggerHandlers.forEach((handler) => {
        handler(event)
      })
    },
  }
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

  it('keeps a worktree-limit block visible when the panel opens', async () => {
    const { api } = stubApi([
      {
        id: 'schedule-a',
        projectId: 'project-a',
        name: 'Morning review',
        cron: '0 9 * * 1-5',
        prompt: 'Review the project.',
        model: BEST_VALUE_CHAT_MODEL,
        enabled: true,
        maxLiveWorktrees: 1,
        createdAt: 1,
        updatedAt: 1,
        lastRunAt: 2,
        lastWorktreeLimitAt: 3,
        lastWorktreeLimitBlockedBy: [
          {
            threadId: 'thread-a',
            title: 'Morning review',
            reason: 'uncommitted-changes',
            paths: ['notes.md'],
          },
        ],
      },
    ])
    const store = createStore({
      activeProjectId: 'project-a',
      projects: [{ id: 'project-a', path: '/repo/a', name: 'Project A' }],
    })
    const root = createAutomationPluginSettings(store, api, true)
    document.body.append(root)
    await tick()

    assert.match(
      root.querySelector('.automation-attention')?.textContent ?? '',
      /1 automation had a run skipped/,
    )
    assert.match(
      root.querySelector('.automation-row-blocked-message')?.textContent ?? '',
      /Last attempt skipped.*Held by “Morning review” has uncommitted changes \(notes\.md\)\./,
    )
    assert.ok(root.querySelector('.automation-row-blocked'))
  })

  it('shows a worktree-limit block when a scheduled run is skipped while open', async () => {
    const schedule: AutomationSchedule = {
      id: 'schedule-a',
      projectId: 'project-a',
      name: 'Morning review',
      cron: '0 9 * * 1-5',
      prompt: 'Review the project.',
      model: BEST_VALUE_CHAT_MODEL,
      enabled: true,
      maxLiveWorktrees: 1,
      createdAt: 1,
      updatedAt: 1,
      lastRunAt: 2,
    }
    const { api, emitTriggered } = stubApi([schedule])
    const store = createStore({
      activeProjectId: 'project-a',
      projects: [{ id: 'project-a', path: '/repo/a', name: 'Project A' }],
    })
    const root = createAutomationPluginSettings(store, api, true)
    document.body.append(root)
    await tick()

    assert.equal(root.querySelector('.automation-attention')?.hasAttribute('hidden'), true)
    schedule.lastWorktreeLimitAt = 3
    emitTriggered({
      projectId: 'project-a',
      scheduleId: schedule.id,
      threadId: 'thread-a',
      triggeredAt: 3,
      disposition: 'coalesced',
      coalescedReason: 'worktree-limit',
    })
    await tick()

    assert.equal(root.querySelector('.automation-attention')?.hasAttribute('hidden'), false)
    assert.match(
      root.querySelector('.automation-row-blocked-message')?.textContent ?? '',
      /Last attempt skipped/,
    )
  })

  it('clears the worktree-limit block when a scheduled run starts while open', async () => {
    const schedule: AutomationSchedule = {
      id: 'schedule-a',
      projectId: 'project-a',
      name: 'Morning review',
      cron: '0 9 * * 1-5',
      prompt: 'Review the project.',
      model: BEST_VALUE_CHAT_MODEL,
      enabled: true,
      maxLiveWorktrees: 1,
      createdAt: 1,
      updatedAt: 1,
      lastRunAt: 2,
      lastWorktreeLimitAt: 3,
    }
    const { api, emitTriggered } = stubApi([schedule])
    const store = createStore({
      activeProjectId: 'project-a',
      projects: [{ id: 'project-a', path: '/repo/a', name: 'Project A' }],
    })
    const root = createAutomationPluginSettings(store, api, true)
    document.body.append(root)
    await tick()

    assert.equal(root.querySelector('.automation-attention')?.hasAttribute('hidden'), false)
    delete schedule.lastWorktreeLimitAt
    emitTriggered({
      projectId: 'project-a',
      scheduleId: schedule.id,
      threadId: 'thread-a',
      triggeredAt: 4,
      disposition: 'started',
    })
    await tick()

    assert.equal(root.querySelector('.automation-attention')?.hasAttribute('hidden'), true)
    assert.equal(root.querySelector('.automation-row-blocked'), null)
  })

  it('explains an invalid save instead of silently leaving the editor open', async () => {
    const { api, upserts } = stubApi([])
    const store = createStore({
      activeProjectId: 'project-a',
      projects: [{ id: 'project-a', path: '/repo/a', name: 'Project A' }],
    })
    const root = createAutomationPluginSettings(store, api, true)
    document.body.append(root)
    await tick()
    root.querySelector<HTMLButtonElement>('.automation-add-btn')?.click()
    await tick()
    root
      .querySelector<HTMLFormElement>('.automation-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    assert.deepEqual(upserts, [])
    assert.match(root.querySelector('.automation-status')?.textContent ?? '', /Enter a name/)
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
    await tick()
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
    const repeat = root.querySelector<HTMLSelectElement>('.automation-repeat-select')
    const time = root.querySelector<HTMLInputElement>('.automation-time-input')
    const weeklyDay = root.querySelector<HTMLSelectElement>('.automation-weekly-day-select')
    const prompt = root.querySelector<HTMLTextAreaElement>('.automation-prompt-input')
    const worktreeLimit = root.querySelector<HTMLSelectElement>('.automation-worktree-limit-select')
    const form = root.querySelector<HTMLFormElement>('.automation-form')
    assert.ok(name && repeat && time && weeklyDay && prompt && worktreeLimit && form)
    assert.equal(root.querySelector('.automation-cron-input'), null)
    const permissionInputs = root.querySelectorAll<HTMLInputElement>('.automation-permission-input')
    assert.equal(permissionInputs.length, 2)
    assert.equal(root.querySelectorAll('.automation-permission-switch').length, 2)
    assert.equal(
      root.querySelectorAll('.automation-permission-switch .toggle-switch-track').length,
      2,
    )
    assert.equal(permissionInputs[0]?.getAttribute('role'), 'switch')
    assert.match(root.textContent, /2 permissions/)
    assert.match(root.textContent, /Copse action/)
    assert.match(root.textContent, /MCP tool/)
    const permissionFilter = root.querySelector<HTMLInputElement>('.automation-permission-filter')
    assert.ok(permissionFilter)
    permissionFilter.value = 'linear create'
    permissionFilter.dispatchEvent(new Event('input', { bubbles: true }))
    const filteredPermissionInputs = root.querySelectorAll<HTMLInputElement>(
      '.automation-permission-input',
    )
    assert.equal(filteredPermissionInputs.length, 1)
    assert.match(root.textContent, /1 of 2 permissions/)
    filteredPermissionInputs[0]?.click()
    permissionFilter.value = 'no such permission'
    permissionFilter.dispatchEvent(new Event('input', { bubbles: true }))
    assert.equal(root.querySelectorAll('.automation-permission-row').length, 0)
    assert.match(root.textContent, /No permissions match/)
    name.value = 'Nightly review'
    repeat.value = 'weekly'
    repeat.dispatchEvent(new Event('change'))
    weeklyDay.value = '4'
    weeklyDay.dispatchEvent(new Event('change'))
    time.value = '14:30'
    time.dispatchEvent(new Event('input'))
    prompt.value = 'Review the diff.'
    worktreeLimit.value = '2'
    assert.equal(
      root.querySelector('.automation-schedule-summary')?.textContent,
      'Every Thursday at 14:30 · local time',
    )
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()

    assert.deepEqual(upserts, [
      {
        projectId: 'project-a',
        input: {
          name: 'Nightly review',
          cron: '30 14 * * 4',
          prompt: 'Review the diff.',
          model: BEST_VALUE_CHAT_MODEL,
          enabled: true,
          maxLiveWorktrees: 2,
          permissions: [{ kind: 'mcp-tool', toolName: 'mcp__linear__create_issue' }],
        },
      },
    ])
  })

  it('opens the schedule a sidebar heading linked to', async () => {
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
    const { api } = stubApi([{ ...schedule, id: 'schedule-other', name: 'Nightly docs' }, schedule])
    const store = createStore({
      activeProjectId: 'project-a',
      projects: [{ id: 'project-a', path: '/repo/a', name: 'Project A' }],
    })
    const root = createAutomationPluginSettings(store, api, true, 'schedule-a')
    document.body.append(root)
    await tick()

    const form = root.querySelector<HTMLFormElement>('.automation-form')
    assert.ok(form)
    assert.equal(form.hidden, false)
    assert.equal(
      root.querySelector<HTMLInputElement>('.automation-name-input')?.value,
      schedule.name,
    )
    assert.equal(
      root.querySelector<HTMLSelectElement>('.automation-repeat-select')?.value,
      'weekdays',
    )
    assert.equal(root.querySelector<HTMLInputElement>('.automation-time-input')?.value, '09:00')
    assert.equal(
      root.querySelector('.automation-schedule-summary')?.textContent,
      'Every weekday at 09:00 · local time',
    )
  })

  it('says so when the linked schedule has since been deleted', async () => {
    // Deleting a schedule leaves its finished runs in the sidebar, so their
    // heading can still link to a schedule that no longer exists.
    const { api } = stubApi([])
    const store = createStore({
      activeProjectId: 'project-a',
      projects: [{ id: 'project-a', path: '/repo/a', name: 'Project A' }],
    })
    const root = createAutomationPluginSettings(store, api, true, 'schedule-gone')
    document.body.append(root)
    await tick()

    const status = root.querySelector<HTMLElement>('.automation-status')
    assert.ok(status)
    assert.equal(status.hidden, false)
    assert.match(status.textContent, /no longer scheduled/i)
    assert.equal(root.querySelector<HTMLFormElement>('.automation-form')?.hidden, true)
  })

  it('keeps editing a schedule that still pins a concrete model', async () => {
    // Schedules written before dynamic selection stay exactly as saved — the
    // picker surfaces the pinned id rather than silently swapping in a rule.
    const schedule: AutomationSchedule = {
      id: 'schedule-a',
      projectId: 'project-a',
      name: 'Morning review',
      cron: '*/15 9-17 * * 1-5',
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
    assert.equal(
      root.querySelector<HTMLSelectElement>('.automation-repeat-select')?.value,
      'custom',
    )
    assert.equal(root.querySelector<HTMLInputElement>('.automation-time-input')?.required, false)
    assert.equal(root.querySelector<HTMLInputElement>('.automation-time-input')?.disabled, true)
    assert.match(
      root.querySelector('.automation-schedule-summary')?.textContent ?? '',
      /older custom schedule/i,
    )
    assert.doesNotMatch(root.textContent, /\*\/15/)
    root
      .querySelector<HTMLFormElement>('.automation-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()
    const upsert = upserts[0]
    assert.ok(upsert)
    assert.equal(upsert.input.model, 'gpt-5.4')
    assert.equal(upsert.input.cron, schedule.cron)
    assert.deepEqual(upsert.input.permissions, [])
  })

  it('normalizes cron Sunday 7 into the weekly Sunday control', async () => {
    const schedule: AutomationSchedule = {
      id: 'schedule-sunday',
      projectId: 'project-a',
      name: 'Sunday review',
      cron: '0 8 * * 7',
      prompt: 'Review the week.',
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

    assert.equal(
      root.querySelector<HTMLSelectElement>('.automation-repeat-select')?.value,
      'weekly',
    )
    assert.equal(root.querySelector<HTMLSelectElement>('.automation-weekly-day-select')?.value, '0')
    assert.equal(
      root.querySelector('.automation-schedule-summary')?.textContent,
      'Every Sunday at 08:00 · local time',
    )
    root
      .querySelector<HTMLFormElement>('.automation-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()

    assert.equal(upserts[0]?.input.cron, '0 8 * * 0')
  })

  it('keeps a selected permission visible when its MCP tool is temporarily unavailable', async () => {
    const schedule: AutomationSchedule = {
      id: 'schedule-a',
      projectId: 'project-a',
      name: 'Morning review',
      cron: '0 9 * * 1-5',
      prompt: 'Review the project.',
      model: 'gpt-5.4',
      enabled: true,
      permissions: [{ kind: 'mcp-tool', toolName: 'mcp__gone__publish_report' }],
      createdAt: 1,
      updatedAt: 1,
    }
    const { api } = stubApi([schedule])
    const store = createStore({
      activeProjectId: 'project-a',
      projects: [{ id: 'project-a', path: '/repo/a', name: 'Project A' }],
    })
    const root = createAutomationPluginSettings(store, api, true, schedule.id)
    document.body.append(root)
    await tick()

    const unavailable = root.querySelector<HTMLInputElement>(
      '.automation-permission-unavailable .automation-permission-input',
    )
    assert.ok(unavailable)
    assert.equal(unavailable.checked, true)
    assert.match(root.textContent, /3 permissions/)
    assert.match(root.textContent, /gone \/ publish_report/)
    assert.match(root.textContent, /works if this tool returns/i)
    const filter = root.querySelector<HTMLInputElement>('.automation-permission-filter')
    assert.ok(filter)
    filter.value = 'publish_report'
    filter.dispatchEvent(new Event('input', { bubbles: true }))
    assert.equal(root.querySelectorAll('.automation-permission-row').length, 1)
    assert.match(root.textContent, /1 of 3 permissions/)
  })

  it('shows branch CI events and saves a new trigger from the shared manager', async () => {
    const { api } = stubApi([])
    const saved: BranchCiAutomation = {
      v: 1,
      id: '11111111-1111-4111-8111-111111111111',
      projectId: 'project-a',
      name: 'Investigate CI',
      trigger: { kind: 'github-ci-failed', repository: 'github.com/owner/repo', branch: 'main' },
      prompt: 'Investigate the failure.',
      model: 'gpt-5.4',
      enabled: false,
      maxLiveWorktrees: 1,
      revision: '22222222-2222-4222-8222-222222222222',
      createdAt: 1,
      updatedAt: 1,
      seenDeliveries: [],
    }
    const ciUpserts: BranchCiAutomationInput[] = []
    api.automations.listBranchCi = (): Promise<BranchCiAutomation[]> => Promise.resolve([saved])
    api.automations.upsertBranchCi = (_projectId, input): Promise<BranchCiAutomation> => {
      ciUpserts.push(input)
      return Promise.resolve(saved)
    }
    const store = createStore({
      activeProjectId: 'project-a',
      projects: [{ id: 'project-a', path: '/repo/a', name: 'Project A' }],
    })
    const root = createAutomationPluginSettings(store, api, true)
    document.body.append(root)
    await tick()
    assert.match(root.querySelector('.automation-ci-list')?.textContent ?? '', /owner\/repo · main/)
    assert.equal(root.querySelectorAll('.automation-add-btn').length, 1)
    assert.equal(root.querySelector('.automation-add-ci-btn'), null)
    root.querySelector<HTMLButtonElement>('.automation-add-btn')?.click()
    await tick()
    const scheduleForm = root.querySelector<HTMLFormElement>(
      '.automation-form:not(.automation-ci-form)',
    )
    const scheduleWhen = scheduleForm?.querySelector<HTMLSelectElement>('.automation-when-select')
    const scheduleName = scheduleForm?.querySelector<HTMLInputElement>('.automation-name-input')
    const schedulePrompt = scheduleForm?.querySelector<HTMLTextAreaElement>(
      '.automation-prompt-input',
    )
    assert.ok(scheduleForm && scheduleWhen && scheduleName && schedulePrompt)
    assert.equal(scheduleWhen.value, 'schedule')
    assert.equal(scheduleWhen.disabled, false)
    scheduleName.value = 'Investigate release CI'
    schedulePrompt.value = 'Find the failing check.'
    scheduleWhen.value = 'github-ci-failed'
    scheduleWhen.dispatchEvent(new Event('change'))
    await tick()
    const ciForm = root.querySelector<HTMLFormElement>('.automation-ci-form')
    assert.ok(ciForm)
    assert.equal(ciForm.hidden, false)
    assert.equal(
      root.querySelector<HTMLFormElement>('.automation-form:not(.automation-ci-form)')?.hidden,
      true,
    )
    const name = ciForm.querySelector<HTMLInputElement>('.automation-ci-name')
    const branch = ciForm.querySelector<HTMLInputElement>('.automation-ci-branch')
    const prompt = ciForm.querySelector<HTMLTextAreaElement>('.automation-ci-prompt')
    const ciWhen = ciForm.querySelector<HTMLSelectElement>('.automation-when-select')
    assert.ok(name && branch && prompt && ciWhen)
    assert.equal(ciWhen.value, 'github-ci-failed')
    assert.equal(name.value, 'Investigate release CI')
    assert.equal(prompt.value, 'Find the failing check.')
    ciWhen.value = 'schedule'
    ciWhen.dispatchEvent(new Event('change'))
    await tick()
    assert.equal(scheduleForm.hidden, false)
    assert.equal(scheduleName.value, 'Investigate release CI')
    assert.equal(schedulePrompt.value, 'Find the failing check.')
    scheduleWhen.value = 'github-ci-failed'
    scheduleWhen.dispatchEvent(new Event('change'))
    await tick()
    assert.equal(ciForm.hidden, false)
    branch.value = 'release/next'
    branch.dispatchEvent(new Event('input', { bubbles: true }))
    prompt.value = 'Find the failing check.'
    assert.match(ciForm.querySelector('.automation-ci-summary')?.textContent ?? '', /release\/next/)
    ciForm.querySelector<HTMLButtonElement>('.automation-ci-preview')?.click()
    await tick()
    assert.match(
      root.querySelector('.automation-status')?.textContent ?? '',
      /did not start a task/,
    )
    ciForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()
    assert.equal(ciUpserts.length, 1)
    assert.deepEqual(ciUpserts[0]?.trigger, { kind: 'github-ci-failed', branch: 'release/next' })
    assert.equal(ciUpserts[0].prompt, 'Find the failing check.')
    root
      .querySelector<HTMLElement>(`[data-ci-automation-id="${saved.id}"] .automation-row-btn`)
      ?.click()
    await tick()
    assert.equal(ciWhen.disabled, true)
    assert.equal(ciWhen.value, 'github-ci-failed')
  })
  it('edits pull request and issue-label triggers, previews matches, and lists deliveries', async () => {
    const { api } = stubApi([])
    const base = {
      v: 1 as const,
      projectId: 'project-a',
      prompt: 'Look.',
      model: 'gpt-5.4',
      enabled: true,
      maxLiveWorktrees: 1 as const,
      revision: '22222222-2222-4222-8222-222222222222',
      createdAt: 1,
      updatedAt: 1,
      seenDeliveries: [],
    }
    const saved: BranchCiAutomation[] = [
      {
        ...base,
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Review PRs',
        trigger: {
          kind: 'github-pr-changed',
          repository: 'github.com/owner/repo',
          baseBranch: 'main',
          transition: 'ready-for-review',
        },
      },
      {
        ...base,
        id: '33333333-3333-4333-8333-333333333333',
        name: 'Triage',
        trigger: {
          kind: 'github-issue-labeled',
          repository: 'github.com/owner/repo',
          label: 'needs-triage',
        },
        lastProblem: {
          at: 5,
          kind: 'failed',
          message: 'Could not read GitHub: rate limited',
          code: 'unknown',
        },
      },
    ]
    const [prDef, issueDef] = saved
    assert.ok(prDef && issueDef)
    const upserts: BranchCiAutomationInput[] = []
    const previews: unknown[] = []
    api.automations.listBranchCi = (): Promise<BranchCiAutomation[]> => Promise.resolve(saved)
    api.automations.upsertBranchCi = (_projectId, input): Promise<BranchCiAutomation> => {
      upserts.push(input)
      return Promise.resolve(prDef)
    }
    api.automations.testBranchCi = (_projectId, trigger): Promise<EventMatchPreview> => {
      previews.push(trigger)
      return Promise.resolve({
        repository: 'github.com/owner/repo',
        branch: 'main',
        latestFailure: null,
        recent: ['#4 Fix the parser'],
      })
    }
    api.automations.eventHistory = (_projectId, id): Promise<EventDeliverySummary[]> =>
      Promise.resolve(
        id === prDef.id
          ? [
              {
                key: 'k1',
                deliveryId: 'pr:4:aaaa:ready',
                outcome: 'started' as const,
                summary: '#4 Fix the parser',
                receivedAt: 10,
                threadId: 'run-1',
              },
              {
                key: 'k2',
                deliveryId: 'pr:5:bbbb:ready',
                outcome: 'filtered' as const,
                reason: 'Pull request transition or base branch does not match',
                summary: '#5 Docs',
                receivedAt: 5,
              },
            ]
          : [],
      )
    const store = createStore({
      activeProjectId: 'project-a',
      projects: [{ id: 'project-a', path: '/repo/a', name: 'Project A' }],
    })
    const opened: string[] = []
    const root = createAutomationPluginSettings(store, api, true, undefined, false, 'project-a', {
      openRun: (threadId) => opened.push(threadId),
    })
    document.body.append(root)
    await tick()

    const rows = root.querySelector('.automation-ci-list')?.textContent ?? ''
    assert.match(rows, /PR ready for review · github\.com\/owner\/repo · main/)
    assert.match(rows, /Issue labelled · github\.com\/owner\/repo · needs-triage/)
    const triage = root.querySelector(`[data-ci-automation-id="${issueDef.id}"]`)
    assert.match(
      triage?.querySelector('.automation-problem-message')?.textContent ?? '',
      /rate limited/,
    )
    assert.match(
      triage?.querySelector('.automation-problem-title')?.textContent ?? '',
      /Could not check GitHub/,
    )

    const details = root.querySelector<HTMLDetailsElement>(
      `[data-ci-automation-id="${prDef.id}"] .automation-deliveries`,
    )
    assert.ok(details)
    details.open = true
    details.dispatchEvent(new Event('toggle'))
    await tick()
    const outcomes = [...details.querySelectorAll('.automation-delivery')].map((item) =>
      item.getAttribute('data-delivery-outcome'),
    )
    assert.deepEqual(outcomes, ['started', 'filtered'])
    assert.match(details.textContent, /transition or base branch does not match/)
    details.querySelector<HTMLButtonElement>('.automation-delivery-open')?.click()
    assert.deepEqual(opened, ['run-1'])

    root
      .querySelector<HTMLElement>(`[data-ci-automation-id="${prDef.id}"] .automation-row-btn`)
      ?.click()
    await tick()
    const form = root.querySelector<HTMLFormElement>('.automation-ci-form')
    assert.ok(form)
    const fieldVisible = (kind: string): boolean =>
      [...form.querySelectorAll<HTMLElement>(`[data-trigger-field="${kind}"]`)].every(
        (node) => !node.hidden,
      )
    assert.equal(fieldVisible('github-pr-changed'), true)
    assert.equal(fieldVisible('github-ci-failed'), false)
    assert.equal(fieldVisible('github-issue-labeled'), false)
    assert.equal(form.querySelector<HTMLInputElement>('.automation-pr-base')?.value, 'main')
    assert.match(
      form.querySelector('.automation-ci-summary')?.textContent ?? '',
      /becomes ready for review/,
    )

    const transition = form.querySelector<HTMLSelectElement>('.automation-pr-transition')
    assert.ok(transition)
    transition.value = 'new-commits'
    transition.dispatchEvent(new Event('change'))
    assert.match(
      form.querySelector('.automation-ci-summary')?.textContent ?? '',
      /gets new commits/,
    )

    form.querySelector<HTMLButtonElement>('.automation-ci-preview')?.click()
    await tick()
    assert.deepEqual(previews, [
      { kind: 'github-pr-changed', baseBranch: 'main', transition: 'new-commits' },
    ])
    assert.match(
      form.querySelector('.automation-ci-matches')?.textContent ?? '',
      /#4 Fix the parser/,
    )

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()
    assert.deepEqual(upserts[0]?.trigger, {
      kind: 'github-pr-changed',
      baseBranch: 'main',
      transition: 'new-commits',
    })
  })

  it('sends workflow filters and a pull request scope for a CI trigger', async () => {
    const { api } = stubApi([])
    const upserts: BranchCiAutomationInput[] = []
    api.automations.upsertBranchCi = (_projectId, input): Promise<BranchCiAutomation> => {
      upserts.push(input)
      return Promise.reject(new Error('stop here'))
    }
    const store = createStore({
      activeProjectId: 'project-a',
      projects: [{ id: 'project-a', path: '/repo/a', name: 'Project A' }],
    })
    const root = createAutomationPluginSettings(store, api, true)
    document.body.append(root)
    await tick()
    root.querySelector<HTMLButtonElement>('.automation-add-btn')?.click()
    await tick()
    const scheduleWhen = root.querySelector<HTMLSelectElement>(
      '.automation-form:not(.automation-ci-form) .automation-when-select',
    )
    assert.ok(scheduleWhen)
    scheduleWhen.value = 'github-ci-failed'
    scheduleWhen.dispatchEvent(new Event('change'))
    await tick()
    const form = root.querySelector<HTMLFormElement>('.automation-ci-form')
    assert.ok(form)
    const set = (selector: string, value: string): void => {
      const input = form.querySelector<HTMLInputElement>(selector)
      assert.ok(input, selector)
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    set('.automation-ci-name', 'Watch PR')
    set('.automation-ci-pull-request', '42')
    set('.automation-ci-checks', 'CI, Lint ,')
    assert.match(
      form.querySelector('.automation-ci-summary')?.textContent ?? '',
      /pull request #42 \(only CI, Lint\)/,
    )
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()
    assert.deepEqual(upserts[0]?.trigger, {
      kind: 'github-ci-failed',
      pullRequest: 42,
      checks: ['CI', 'Lint'],
    })
    assert.match(root.querySelector('.automation-status')?.textContent ?? '', /stop here/)
  })
})
