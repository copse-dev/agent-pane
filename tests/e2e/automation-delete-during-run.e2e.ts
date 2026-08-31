import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { AUTOMATIONS_PLUGIN_ID } from '../../packages/agent/src/plugins/automations-plugin.ts'
import { prepareE2eScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-automation-delete-during-run'
const SCHEDULE_ID = 'schedule-delete-during-run'

interface AutomationTestBridge {
  setAutomationThreadLoadsPaused: (paused: boolean) => Promise<void>
}

async function setThreadLoadsPaused(paused: boolean): Promise<void> {
  await browser.execute(async (value) => {
    const bridge = (window as unknown as { __copseE2e?: AutomationTestBridge }).__copseE2e
    if (!bridge) throw new Error('__copseE2e automation controls unavailable')
    await bridge.setAutomationThreadLoadsPaused(value)
  }, paused)
}

describe('deleting an automation while Run now is loading', function () {
  this.timeout(60_000)

  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID)
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      [`threads:${PROJECT_ID}`]: [],
      pluginDisabled: [],
      pluginMigration: { automationsEnablement: true },
      plugin: {
        copse: {
          automations: {
            storage: [
              {
                id: SCHEDULE_ID,
                projectId: PROJECT_ID,
                name: 'Temporary review',
                cron: '0 9 * * 1-5',
                prompt: 'Review the project.',
                model: 'best-value',
                enabled: false,
                createdAt: 1_786_000_000_000,
                updatedAt: 1_786_000_000_000,
              },
            ],
          },
        },
      },
    })
    await browser.reloadSession()
  })

  after(async () => {
    await setThreadLoadsPaused(false).catch(() => undefined)
    resetUserData()
  })

  it('keeps the schedule deleted after the pending run finishes', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.execute(() => {
      const scope = window as unknown as {
        api: typeof window.api
        automationRunCompleted?: boolean
      }
      scope.automationRunCompleted = false
      scope.api.automations.onTriggered(() => {
        scope.automationRunCompleted = true
      })
    })
    await setThreadLoadsPaused(true)

    await $('[aria-label="Settings"]').click()
    const dialog = $('#settings-dialog')
    await dialog.$('button[data-section="customise"]').click()
    const plugin = dialog.$(`.plugin-row[data-plugin-id="${AUTOMATIONS_PLUGIN_ID}"]`)
    await plugin.waitForExist({ timeout: 15_000 })
    await plugin.$('.plugin-settings-summary').click()
    const detail = plugin.$('.automation-plugin-settings')
    await expect(detail).toBeDisplayed()

    const row = detail.$(`.automation-row[data-schedule-id="${SCHEDULE_ID}"]`)
    await row.$('.automation-run-btn').click()
    await row.$('.automation-remove-btn').click()
    const confirm = $('#confirm-dialog')
    await expect(confirm).toBeDisplayed()
    await expect(confirm.$('.confirm-dialog-confirm')).toHaveText('Delete schedule')
    await confirm.$('.confirm-dialog-confirm').click()
    await expect(detail.$('.automation-empty')).toBeDisplayed()

    await setThreadLoadsPaused(false)
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          Boolean(
            (window as unknown as { automationRunCompleted?: boolean }).automationRunCompleted,
          ),
        ),
      { timeout: 10_000, timeoutMsg: 'the paused automation run never completed' },
    )
    const schedules = await browser.execute(
      async (projectId) => window.api.automations.list(projectId),
      PROJECT_ID,
    )
    assert.deepEqual(schedules, [])
    await expect(detail.$('.automation-empty')).toBeDisplayed()
    assert.equal(await detail.$('.automation-row').isExisting(), false)

    await prepareE2eScreenshot()
    await saveElementScreenshot('.automation-plugin-settings', 'automation-delete-during-run.png')
  })
})
