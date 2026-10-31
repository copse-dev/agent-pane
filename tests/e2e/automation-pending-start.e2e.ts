import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'
import {
  resetUserData,
  seedStableWorkspace,
  seedEmptyProject,
  writeSeedConfig,
} from './helpers/seed-config.ts'

// Visual evidence that a just-triggered automation run shows as starting before its
// status flips to 'running' — the renderer's checkout prep and the main-process
// model preflight both happen before that flip, so a run that only lit up on
// `status === 'running'` stayed invisible for that whole window. The fix reads
// `pending-start` (the thread is created with a queued draft prompt but has not
// started) the same way it reads `running`, in every place that used to key off
// `running` alone (src/renderer/controller/sidebar-thread.ts#isAutomationPendingStart).
//
// The pending-start thread shape (`status: 'idle'`, `draftPrompt` set, `automation`
// without `startFailedAt`) is the real shape `AutomationService.trigger` persists
// before the renderer ever calls `agent.run` (src/main/services/automations/
// automation-service.ts), so seeding it directly is seeding through a real field,
// not a test-only path.
//
// The pending thread lives in a project that never becomes active: `startPendingForActiveProject`
// (src/renderer/controller/automations.ts) only scans `store.getState().threads`, the active
// project's own list, to auto-start a queued draft. A background project's threads instead reach
// the sidebar and Activity panel through `preloadSidebarThreads` (src/renderer/controller/
// projects.ts), which never calls it — so the pending-start state renders and holds, instead of
// racing the real auto-start-and-finish (the mock LLM completes an unconfigured turn instantly).

const ACTIVE_PROJECT_ID = 'e2e-automation-pending-start-active'
const PROJECT_ID = 'e2e-automation-pending-start'
const SCHEDULE_ID = 'schedule-nightly-build'
const PENDING_THREAD_ID = 'pending-run'
const SEEDED_AT = 1_786_000_000_000

describe('automation run pending its first start', function () {
  this.timeout(120_000)

  before(async () => {
    resetUserData()
    const activeWorkspace = seedStableWorkspace()
    const workspace = seedStableWorkspace()
    seedEmptyProject(activeWorkspace, ACTIVE_PROJECT_ID, { model: 'claude-sonnet-4-6' })
    seedEmptyProject(workspace, PROJECT_ID, { model: 'claude-sonnet-4-6' })
    writeSeedConfig({
      projects: [
        { id: ACTIVE_PROJECT_ID, path: activeWorkspace, name: 'active' },
        { id: PROJECT_ID, path: workspace, name: 'workspace' },
      ],
      activeProjectId: ACTIVE_PROJECT_ID,
      activeThreadId: 'regular-chat',
      [`threads:${ACTIVE_PROJECT_ID}`]: [
        {
          id: 'regular-chat',
          title: 'Release planning',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: SEEDED_AT,
          updatedAt: SEEDED_AT,
        },
      ],
      [`threads:${PROJECT_ID}`]: [
        {
          id: PENDING_THREAD_ID,
          title: 'Nightly build',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          draftPrompt: 'Run the nightly build and report failures.',
          automation: {
            scheduleId: SCHEDULE_ID,
            scheduleName: 'Nightly build',
            triggeredAt: SEEDED_AT + 1_000,
          },
          createdAt: SEEDED_AT + 1_000,
          updatedAt: SEEDED_AT + 1_000,
        },
      ],
      pluginDisabled: [],
      pluginMigration: { automationsEnablement: true },
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows the sidebar row and schedule heading as starting, before status flips to running', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    const toggle = $('.automation-threads-toggle')
    // The background project's threads load asynchronously (preloadSidebarThreads), after
    // the active project's own UI is already interactive.
    await toggle.waitForExist({ timeout: 15_000 })
    await expect(toggle.$('.automation-threads-running')).toExist()
    await toggle.click()

    const row = $(`.chat-row[data-thread-id="${PENDING_THREAD_ID}"]`)
    await expect(row).toBeDisplayed()
    await expect(row).toHaveElementClass('is-running')
    await expect(row.$('.chat-running-status')).toHaveAttribute('aria-label', 'Starting…')

    await saveElementScreenshot('.automation-threads-group', 'automation-pending-start-sidebar.png')
  })

  it('shows the pending run in the Activity panel as working, with a Starting want', async () => {
    await $('.prompt-input').click()
    await browser.keys([process.platform === 'darwin' ? 'Meta' : 'Control', 'Shift', 'a'])
    await $('#activity-panel').waitForDisplayed({ timeout: 10_000 })

    const row = $(`#activity-panel .activity-row[data-thread-id="${PENDING_THREAD_ID}"]`)
    await expect(row).toBeDisplayed()
    await expect(row).toHaveAttribute('data-state', 'working')
    await expect(row.$('.activity-want-text')).toHaveText('Starting…')

    await saveAppScreenshot('automation-pending-start-activity.png')
  })
})
