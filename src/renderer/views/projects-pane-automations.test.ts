import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { AutomationSchedule, Thread } from '@shared/types'
import type { PluginSummary } from '@shared/types/plugins.ts'
import { AUTOMATIONS_PLUGIN_ID } from '@copse/agent/plugins/automations-plugin.ts'
import { createFakeApi, createPendingApi } from '../fake-api.test-support.ts'
import { resetProjectSwitchStateForTest, setThreadCacheForTest } from '../controller/projects.ts'
import { resetAttention, setAttentionThreads } from '../controller/attention.ts'
import { mountProjectsPane } from './projects-pane.ts'
import { dismissContextMenu } from '../dom/context-menu.ts'
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
      { id: 'automation-manager', level: 3, slot: 'app-dialog', title: 'Automations' },
    ],
    followUps: [],
    capabilities: [],
    instructionSources: [],
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
  dismissContextMenu()
  if (isSettingsDialogOpen()) closeSettingsDialog()
  document.querySelector<HTMLDialogElement>('#automation-dialog')?.close()
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
    // The workspace-level Automations section renders ahead of the project
    // itself (#2511), so its lone "Issue triage" row precedes the project's
    // own "Regular conversation" further down; "Docs freshness" has two runs
    // and stays behind its own (still-collapsed) schedule heading.
    assert.deepEqual(
      Array.from(host.querySelectorAll('.chat-title')).map((node) => node.textContent),
      ['Issue triage', 'Regular conversation'],
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

    assert.equal(isSettingsDialogOpen(), false)
    const pluginRow = document.querySelector<HTMLDialogElement>('#automation-dialog')
    assert.ok(pluginRow?.open)
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

  it('opens a new automation against the active project from the workspace heading', async () => {
    const host = mountWithSettings([thread('docs', 'Docs freshness', 'schedule-docs')], 'docs')

    const setup = host.querySelector<HTMLButtonElement>(
      '.automation-threads-header .automation-setup-btn',
    )
    assert.ok(setup)
    // The heading has no single project of its own to link to, so — like the
    // project menu's own "New automation…" — it opens the create form rather
    // than routing through the packs/settings page.
    assert.equal(setup.getAttribute('aria-label'), 'New automation…')
    setup.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(isSettingsDialogOpen(), false)
    const pluginRow = document.querySelector<HTMLDialogElement>('#automation-dialog')
    assert.ok(pluginRow?.open)
    assert.match(pluginRow.querySelector('.automation-scope')?.textContent ?? '', /Project: Alpha/)
    const form = pluginRow.querySelector<HTMLFormElement>('.automation-form')
    assert.ok(form)
    assert.equal(form.hidden, false)
    assert.equal(form.querySelector<HTMLInputElement>('.automation-name-input')?.value, '')
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

describe('workspace-level automations section (#2511)', () => {
  /**
   * Two projects, each with its own schedule. `getSidebarThreads` only has
   * data for the active project's live `threads` plus whatever a background
   * project cached from an earlier switch this session, so a project's
   * automation runs are seeded through `setThreadCacheForTest` exactly the
   * way a real switch would have populated that cache.
   */
  function mountTwoProjects(): { host: HTMLElement; store: ReturnType<typeof createStore> } {
    const store = createStore({
      projects: [
        { id: 'a', path: '/a', name: 'Alpha' },
        { id: 'b', path: '/b', name: 'Beta' },
      ],
      activeProjectId: 'a',
      expandedProjectId: 'a',
      workspaceRoot: '/a',
      threads: [
        thread('chat', 'Regular conversation'),
        thread('docs', 'Docs freshness', 'schedule-docs'),
      ],
      activeThreadId: 'chat',
    })
    setThreadCacheForTest('b', [thread('issues', 'Issue triage', 'schedule-issues')])
    const host = document.createElement('div')
    document.body.append(host)
    mountProjectsPane(host, store, createFakeApi())
    return { host, store }
  }

  it('collates runs from every project under the workspace heading instead of inside each project', () => {
    const { host } = mountTwoProjects()

    const list = host.querySelector('.projects-list')
    assert.ok(list)
    // Directly under the workspace: the section is the list's first child,
    // ahead of both projects' own entries.
    assert.ok(list.firstElementChild?.classList.contains('automation-threads-group'))

    const toggle = host.querySelector<HTMLButtonElement>('.automation-threads-toggle')
    assert.ok(toggle)
    assert.equal(toggle.querySelector('.automation-threads-count')?.textContent, '2')

    toggle.click()
    // Both schedules are collated in the one section...
    assert.deepEqual(
      Array.from(host.querySelectorAll('.automation-thread-rows .chat-title')).map(
        (node) => node.textContent,
      ),
      ['Docs freshness', 'Issue triage'],
    )
    // ...and neither renders inside its own (expanded) project's thread list.
    assert.equal(
      host.querySelectorAll('.project-entry .chats-list .chat-row.is-automation').length,
      0,
    )
  })

  it('names the owning project as a muted suffix on each collated row', () => {
    const { host } = mountTwoProjects()
    host.querySelector<HTMLButtonElement>('.automation-threads-toggle')?.click()

    const rows = Array.from(host.querySelectorAll('.automation-thread-rows .chat-row'))
    const suffixFor = (title: string): string | undefined =>
      rows
        .find((row) => row.querySelector('.chat-title')?.textContent === title)
        ?.querySelector('.chat-thread-owner')?.textContent ?? undefined

    assert.equal(suffixFor('Docs freshness'), '· Alpha')
    assert.equal(suffixFor('Issue triage'), '· Beta')
  })

  it('opens the thread in its owning project when a collated row is selected', async () => {
    const store = createStore({
      projects: [
        { id: 'a', path: '/a', name: 'Alpha' },
        { id: 'b', path: '/b', name: 'Beta' },
      ],
      activeProjectId: 'a',
      expandedProjectId: 'a',
      workspaceRoot: '/a',
      threads: [
        thread('chat', 'Regular conversation'),
        thread('docs', 'Docs freshness', 'schedule-docs'),
      ],
      activeThreadId: 'chat',
    })
    const issuesThread = thread('issues', 'Issue triage', 'schedule-issues')
    setThreadCacheForTest('b', [issuesThread])
    const api = createFakeApi()
    // Activating project 'b' for real (not just reading its sidebar cache)
    // loads its threads over IPC — seed that load with the same thread the
    // cache primed the row from, so the switch lands on it rather than a
    // freshly minted blank thread.
    api.threads.loadProject = (projectId: string): Promise<Thread[]> =>
      Promise.resolve(projectId === 'b' ? [issuesThread] : [])
    const host = document.createElement('div')
    document.body.append(host)
    mountProjectsPane(host, store, api)
    host.querySelector<HTMLButtonElement>('.automation-threads-toggle')?.click()

    const row = Array.from(host.querySelectorAll('.automation-thread-rows .chat-row')).find(
      (candidate) => candidate.querySelector('.chat-title')?.textContent === 'Issue triage',
    )
    assert.ok(row)
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    // Switching to a background project round-trips through the fake API.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(store.getState().activeProjectId, 'b')
    assert.equal(store.getState().activeThreadId, 'issues')
  })

  it('opens setup against a row’s own project without switching the active project', async () => {
    const store = createStore({
      projects: [
        { id: 'a', path: '/a', name: 'Alpha' },
        { id: 'b', path: '/b', name: 'Beta' },
      ],
      activeProjectId: 'a',
      expandedProjectId: 'a',
      workspaceRoot: '/a',
      threads: [thread('chat', 'Regular conversation')],
      activeThreadId: 'chat',
    })
    setThreadCacheForTest('b', [thread('issues', 'Issue triage', 'schedule-issues')])
    const requestedProjects: string[] = []
    const api = createPendingApi({
      'plugins.list': () => Promise.resolve({ plugins: [automationsPlugin] }),
      'cursorPlugins.list': () => Promise.resolve([]),
      'automations.list': (projectId: string) => {
        requestedProjects.push(projectId)
        return Promise.resolve([{ ...schedule, id: 'schedule-issues', projectId: 'b' }])
      },
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountSettingsDialog(store, api)
    mountProjectsPane(host, store, api)
    host.querySelector<HTMLButtonElement>('.automation-threads-toggle')?.click()

    const row = Array.from(host.querySelectorAll('.automation-thread-rows .chat-row')).find(
      (candidate) => candidate.querySelector('.chat-title')?.textContent === 'Issue triage',
    )
    assert.ok(row)
    row.querySelector<HTMLButtonElement>('.automation-setup-btn')?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const dialog = document.querySelector<HTMLDialogElement>('#automation-dialog')
    assert.ok(dialog?.open)
    assert.match(dialog.querySelector('.automation-scope')?.textContent ?? '', /Project: Beta/)
    assert.deepEqual(requestedProjects, ['b'])
    // Configuring another project's automation in place must not move the
    // user off the project they were on (mirrors the project-menu behaviour
    // below).
    assert.equal(store.getState().activeProjectId, 'a')
  })
})

describe('project row automation menu', () => {
  for (const label of ['Automations', 'New automation…']) {
    it(`opens ${label} for the selected row without changing the active project`, async () => {
      const store = createStore({
        projects: [
          { id: 'a', path: '/a', name: 'Alpha' },
          { id: 'b', path: '/b', name: 'Beta' },
        ],
        activeProjectId: 'a',
        expandedProjectId: 'a',
        workspaceRoot: '/a',
      })
      const requestedProjects: string[] = []
      const api = createFakeApi()
      api.plugins.list = (): Promise<{ plugins: PluginSummary[] }> =>
        Promise.resolve({ plugins: [automationsPlugin] })
      api.automations.list = (projectId): Promise<AutomationSchedule[]> => {
        requestedProjects.push(projectId)
        return Promise.resolve([])
      }
      const host = document.createElement('div')
      document.body.append(host)
      const dispose = mountProjectsPane(host, store, api)
      assert.equal(host.querySelector('.projects-menu-btn'), null)
      assert.equal(host.querySelectorAll('.project-line .project-menu-btn').length, 2)
      const button = host.querySelector<HTMLButtonElement>(
        '.project-entry[data-project-id="b"] .project-menu-btn',
      )
      assert.ok(button)
      button.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
      const menuItems = Array.from(
        document.querySelectorAll<HTMLButtonElement>('.context-menu-item'),
      )
      assert.ok(menuItems.some((item) => item.textContent === 'Remove from sidebar'))
      const action = menuItems.find((item) => item.textContent === label)
      assert.ok(action)
      action.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
      const dialog = document.querySelector<HTMLDialogElement>('#automation-dialog')
      assert.ok(dialog?.open)
      assert.match(dialog.querySelector('.automation-scope')?.textContent ?? '', /Project: Beta/)
      assert.deepEqual(requestedProjects, ['b'])
      assert.equal(store.getState().activeProjectId, 'a')
      assert.equal(store.getState().expandedProjectId, 'a')
      assert.equal(
        dialog.querySelector<HTMLFormElement>('.automation-form')?.hidden,
        label !== 'New automation…',
      )
      dispose()
    })
  }

  it('keeps project actions available without the automation plugin', async () => {
    const host = mount([], '')
    host.querySelector<HTMLButtonElement>('.project-menu-btn')?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const labels = Array.from(document.querySelectorAll('.context-menu-item')).map(
      (item) => item.textContent,
    )
    assert.ok(labels.includes('Remove from sidebar'))
    assert.ok(!labels.includes('Automations'))
    assert.ok(!labels.includes('New automation…'))
  })
})
