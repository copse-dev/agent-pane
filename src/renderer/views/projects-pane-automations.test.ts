import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { AutomationSchedule, Thread } from '@shared/types'
import type { PluginSummary } from '@shared/types/plugins.ts'
import { AUTOMATIONS_PLUGIN_ID } from '@copse/agent/plugins/automations-plugin.ts'
import { createFakeApi, createPendingApi } from '../fake-api.test-support.ts'
import { resetProjectSwitchStateForTest } from '../controller/projects.ts'
import { resetAttention, setAttentionThreads } from '../controller/attention.ts'
import { mountProjectsPane } from './projects-pane.ts'
import {
  closeSettingsDialog,
  isSettingsDialogOpen,
  mountSettingsDialog,
} from './settings-dialog.ts'

function thread(id: string, title: string, scheduleId?: string, triggeredAt = 10): Thread {
  return {
    id,
    title,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    ...(scheduleId
      ? {
          automation: {
            scheduleId,
            scheduleName: title,
            triggeredAt,
          },
        }
      : {}),
    createdAt: 1,
    updatedAt: 1,
  }
}

function mount(threads: Thread[], activeThreadId: string): HTMLElement {
  const store = createStore({
    projects: [{ id: 'a', path: '/a', name: 'Alpha' }],
    activeProjectId: 'a',
    expandedProjectId: 'a',
    workspaceRoot: '/a',
    threads,
    activeThreadId,
  })
  const host = document.createElement('div')
  document.body.append(host)
  mountProjectsPane(host, store, createFakeApi())
  return host
}

const schedule: AutomationSchedule = {
  id: 'schedule-docs',
  projectId: 'a',
  name: 'Docs freshness',
  cron: '0 9 * * 1-5',
  prompt: 'Check the docs against the code.',
  model: 'gpt-5.4',
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
}

const automationsPlugin: PluginSummary = {
  id: AUTOMATIONS_PLUGIN_ID,
  trust: 'first-party',
  stability: 'experimental',
  name: AUTOMATIONS_PLUGIN_ID,
  enabled: true,
  contributions: {
    toolNames: [],
    modelRoutes: [],
    browserOrigins: [],
    blockingHooks: [],
    asyncHooks: [],
    commandHooks: [],
    promptBlocks: [],
    ui: [
      {
        id: 'schedule-editor',
        level: 3,
        slot: 'settings-plugin-detail',
        title: 'Automation schedules',
      },
    ],
    followUps: [],
    capabilities: [],
    permissions: [],
    storageNamespace: AUTOMATIONS_PLUGIN_ID,
  },
  settings: [],
}

/**
 * Sidebar plus the settings dialog it links into, sharing one API stub: the
 * click-through crosses both, and anything the stub doesn't answer stays pending
 * rather than resolving into a shape the dialog would then read.
 */
function mountWithSettings(threads: Thread[], activeThreadId: string): HTMLElement {
  const store = createStore({
    projects: [{ id: 'a', path: '/a', name: 'Alpha' }],
    activeProjectId: 'a',
    expandedProjectId: 'a',
    workspaceRoot: '/a',
    threads,
    activeThreadId,
  })
  const api = createPendingApi({
    'plugins.list': () => Promise.resolve({ plugins: [automationsPlugin] }),
    'cursorPlugins.list': () => Promise.resolve([]),
    'automations.list': () => Promise.resolve([schedule]),
  })
  const host = document.createElement('div')
  document.body.append(host)
  mountSettingsDialog(store, api)
  mountProjectsPane(host, store, api)
  return host
}

afterEach(() => {
  if (isSettingsDialogOpen()) closeSettingsDialog()
  document.body.replaceChildren()
  resetProjectSwitchStateForTest()
  resetAttention()
})

describe('projects pane automation group', () => {
  it('keeps automation threads behind one collapsed disclosure', () => {
    const host = mount(
      [
        thread('chat', 'Regular conversation'),
        thread('docs-latest', 'Docs freshness', 'schedule-docs', 20),
        thread('docs-previous', 'Docs freshness', 'schedule-docs', 10),
        thread('issues', 'Issue triage', 'schedule-issues'),
      ],
      'chat',
    )

    const toggle = host.querySelector<HTMLButtonElement>('.automation-threads-toggle')
    assert.ok(toggle)
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(toggle.querySelector('.automation-threads-count')?.textContent, '2')
    assert.deepEqual(
      Array.from(host.querySelectorAll('.chat-title')).map((node) => node.textContent),
      ['Regular conversation'],
    )

    toggle.click()
    assert.equal(
      host.querySelector('.automation-threads-toggle')?.getAttribute('aria-expanded'),
      'true',
    )
    assert.deepEqual(
      Array.from(host.querySelectorAll('.chat-title')).map((node) => node.textContent),
      ['Regular conversation', 'Issue triage'],
    )
    const scheduleToggle = host.querySelector<HTMLButtonElement>(
      '.automation-schedule-group[data-schedule-id="schedule-docs"] .automation-schedule-toggle',
    )
    assert.ok(scheduleToggle)
    assert.equal(scheduleToggle.getAttribute('aria-expanded'), 'false')
    assert.equal(
      scheduleToggle.querySelector('.automation-schedule-title')?.textContent,
      'Docs freshness',
    )
    assert.equal(scheduleToggle.querySelector('.automation-schedule-count')?.textContent, '2 runs')

    scheduleToggle.click()
    const runRows = host.querySelectorAll(
      '.automation-schedule-group[data-schedule-id="schedule-docs"] .automation-schedule-runs .chat-row',
    )
    assert.equal(runRows.length, 2)
    assert.match(runRows[0]?.textContent ?? '', /^Latest · /)
  })

  it('reveals an automation thread when it is the current selection', () => {
    const host = mount(
      [thread('chat', 'Regular conversation'), thread('docs', 'Docs freshness', 'schedule-docs')],
      'docs',
    )

    assert.equal(
      host.querySelector('.automation-threads-toggle')?.getAttribute('aria-expanded'),
      'true',
    )
    assert.equal(
      host.querySelector('.chat-row.is-automation.selected .chat-title')?.textContent,
      'Docs freshness',
    )
  })

  it('reveals the owning schedule when a historical run is selected', () => {
    const host = mount(
      [
        thread('docs-latest', 'Docs freshness', 'schedule-docs', 20),
        thread('docs-previous', 'Docs freshness', 'schedule-docs', 10),
      ],
      'docs-previous',
    )

    assert.equal(
      host.querySelector('.automation-threads-toggle')?.getAttribute('aria-expanded'),
      'true',
    )
    assert.equal(
      host.querySelector('.automation-schedule-toggle')?.getAttribute('aria-expanded'),
      'true',
    )
    assert.equal(
      host
        .querySelector('.automation-schedule-runs .chat-row.selected')
        ?.getAttribute('data-thread-id'),
      'docs-previous',
    )
  })

  it('auto-reveals only runs needing attention beneath their schedule', () => {
    const store = createStore({
      projects: [{ id: 'a', path: '/a', name: 'Alpha' }],
      activeProjectId: 'a',
      expandedProjectId: 'a',
      workspaceRoot: '/a',
      threads: [
        thread('chat', 'Regular conversation'),
        thread('docs-latest', 'Docs freshness', 'schedule-docs', 30),
        thread('docs-waiting', 'Docs freshness', 'schedule-docs', 20),
        thread('docs-oldest', 'Docs freshness', 'schedule-docs', 10),
      ],
      activeThreadId: 'chat',
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountProjectsPane(host, store, createFakeApi())

    setAttentionThreads(store, 'approval', ['docs-waiting'])

    const automationToggle = host.querySelector('.automation-threads-toggle')
    const scheduleToggle = host.querySelector('.automation-schedule-toggle')
    assert.ok(automationToggle && scheduleToggle)
    assert.equal(automationToggle.getAttribute('aria-expanded'), 'true')
    assert.equal(scheduleToggle.getAttribute('aria-expanded'), 'false')
    assert.equal(automationToggle.querySelectorAll('.chat-attention-bell').length, 0)
    assert.equal(scheduleToggle.querySelectorAll('.chat-attention-bell').length, 0)
    const visibleRuns = host.querySelectorAll('.automation-schedule-runs .chat-row')
    assert.equal(visibleRuns.length, 1)
    const visibleRun = visibleRuns.item(0)
    assert.ok(visibleRun)
    assert.equal(visibleRun.getAttribute('data-thread-id'), 'docs-waiting')
    assert.equal(visibleRun.querySelectorAll('.chat-attention-bell').length, 1)

    scheduleToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    assert.equal(
      host.querySelector('.automation-schedule-toggle')?.getAttribute('aria-expanded'),
      'true',
    )
    assert.equal(host.querySelectorAll('.automation-schedule-runs .chat-row').length, 3)
  })
})

describe('projects pane automation setup links', () => {
  it('opens the linked schedule’s editor from its heading', async () => {
    const host = mountWithSettings(
      [
        thread('chat', 'Regular conversation'),
        thread('docs-latest', 'Docs freshness', 'schedule-docs', 20),
        thread('docs-previous', 'Docs freshness', 'schedule-docs', 10),
      ],
      'chat',
    )
    host.querySelector<HTMLButtonElement>('.automation-threads-toggle')?.click()

    const header = host.querySelector('.automation-schedule-header')
    assert.ok(header)
    const setup = header.querySelector<HTMLButtonElement>('.automation-setup-btn')
    assert.ok(setup)
    assert.equal(setup.getAttribute('aria-label'), 'Docs freshness setup')
    setup.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(isSettingsDialogOpen(), true)
    const pluginsSection = document.querySelector('.settings-section[data-section="customise"]')
    assert.ok(pluginsSection?.classList.contains('active'))
    // The plugin's detail sits inside a fold that is closed by default; a deep
    // link that left it closed would land on the card, not on the schedule.
    const pluginRow = document.querySelector(
      `.plugin-row[data-plugin-id="${AUTOMATIONS_PLUGIN_ID}"]`,
    )
    assert.ok(pluginRow)
    assert.equal(pluginRow.querySelector<HTMLDetailsElement>('.plugin-settings-fold')?.open, true)
    const form = pluginRow.querySelector<HTMLFormElement>('.automation-form')
    assert.ok(form)
    assert.equal(form.hidden, false)
    assert.equal(
      pluginRow.querySelector<HTMLInputElement>('.automation-name-input')?.value,
      schedule.name,
    )

    // Expansion still belongs to the heading itself.
    assert.equal(
      host.querySelector('.automation-schedule-toggle')?.getAttribute('aria-expanded'),
      'false',
    )
  })

  it('opens the project’s schedule list from the Automations heading', async () => {
    const host = mountWithSettings([thread('docs', 'Docs freshness', 'schedule-docs')], 'docs')

    const setup = host.querySelector<HTMLButtonElement>(
      '.automation-threads-header .automation-setup-btn',
    )
    assert.ok(setup)
    assert.equal(setup.getAttribute('aria-label'), 'Automation settings')
    setup.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(isSettingsDialogOpen(), true)
    const pluginRow = document.querySelector(
      `.plugin-row[data-plugin-id="${AUTOMATIONS_PLUGIN_ID}"]`,
    )
    assert.ok(pluginRow)
    assert.match(pluginRow.querySelector('.automation-list')?.textContent ?? '', /Docs freshness/)
    // No schedule was named, so the list stays the destination.
    assert.equal(pluginRow.querySelector<HTMLFormElement>('.automation-form')?.hidden, true)
  })

  it('offers the setup on an automation row, where a single run has no heading', () => {
    const host = mountWithSettings(
      [thread('chat', 'Regular conversation'), thread('docs', 'Docs freshness', 'schedule-docs')],
      'docs',
    )
    const labelsFor = (row: Element): (string | null)[] => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
      const items = Array.from(document.querySelectorAll('.context-menu-item')).map(
        (item) => item.textContent,
      )
      document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      return items
    }

    const automationRow = host.querySelector('.chat-row.is-automation')
    const conversationRow = host.querySelector('.chat-row:not(.is-automation)')
    assert.ok(automationRow && conversationRow)
    assert.deepEqual(labelsFor(automationRow), ['Rename', 'Fork', 'Archive', 'Automation setup…'])
    assert.deepEqual(labelsFor(conversationRow), ['Rename', 'Fork', 'Archive'])
  })
})
