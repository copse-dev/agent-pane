import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { AUTOMATIONS_PLUGIN_ID } from '../../packages/agent/src/plugins/automations-plugin.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { isDisplayFace, readHeadingStyle } from './helpers/heading-style.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-settings-automations'
const SCHEDULE_ID = 'schedule-morning-review'

describe('settings automations plugin', function () {
  this.timeout(60_000)

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID, { model: 'claude-sonnet-4-6' })
    // The automations plugin has no legacy opt-in, so production seeds it off
    // once. Mark that migration complete and seed the explicit enabled state +
    // plugin storage for this visual fixture.
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      [`threads:${PROJECT_ID}`]: [],
      pluginDisabled: [],
      // electron-store resolves dotted keys through nested config objects.
      pluginMigration: { automationsEnablement: true },
      plugin: {
        copse: {
          automations: {
            storage: [
              {
                id: SCHEDULE_ID,
                projectId: PROJECT_ID,
                name: 'Weekday project review',
                cron: '0 9 * * 1-5',
                prompt: 'Review open work and prepare a concise project status update.',
                model: 'claude-sonnet-4-6',
                // Keep the visual fixture deterministic: the production scheduler is
                // live during e2e, so an armed weekday schedule could create a task
                // when CI happens to run at 09:00 local time.
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

  after(() => {
    resetUserData()
  })

  it('renders project scope, a readable schedule, model, and the permission boundary', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()
    await dialog.$('button[data-section="customise"]').click()

    const row = dialog.$(`.plugin-row[data-plugin-id="${AUTOMATIONS_PLUGIN_ID}"]`)
    await row.waitForExist({ timeout: 15_000 })
    await row.scrollIntoView({ block: 'center' })
    assert.equal(await row.getAttribute('data-enabled'), 'true')
    await expect(row.$('.plugin-chip=UI × 2')).toBeDisplayed()

    // The plugin's detail panel sits inside its closed "Plugin settings" fold.
    await row.$('.plugin-settings-summary').click()
    const detail = row.$('.automation-plugin-settings')
    await expect(detail).toBeDisplayed()
    assert.match(await detail.getText(), /Project: workspace · local time/)
    assert.match(await detail.getText(), /Weekday project review/)
    assert.match(await detail.getText(), /Every weekday at 09:00/)
    assert.doesNotMatch(await detail.getText(), /0 9 \* \* 1-5/)
    assert.match(await detail.getText(), /Claude Sonnet 4\.6/)
    assert.match(await detail.getText(), /Each run starts a fresh isolated task/i)
    assert.match(await detail.getText(), /One live worktree is the safe default/i)
    assert.match(await detail.getText(), /1 live worktree max/i)
    assert.match(await detail.getText(), /Normal tool permission prompts still apply/i)
    await expect(detail.$('.automation-run-btn')).toBeEnabled()
    await saveElementScreenshot('.automation-plugin-settings', 'settings-automations.png')

    // Capture the editor separately so the settings dialog's sticky global
    // footer cannot cover a tall schedule form in the reference image.
    await detail.$('.automation-add-btn').click()
    await expect(detail.$('.automation-form')).toBeDisplayed()
    await expect(detail.$('.automation-form .model-picker-field')).toBeDisplayed()
    await expect(detail.$('.automation-cron-input')).not.toExist()
    await expect(detail.$('.automation-repeat-select')).toHaveValue('weekdays')
    await expect(detail.$('.automation-time-input')).toHaveValue('09:00')
    await expect(detail.$('.automation-schedule-summary')).toHaveText(
      'Every weekday at 09:00 · local time',
    )
    await expect(detail.$('.automation-worktree-limit-select')).toHaveValue('1')
    await expect(dialog.$('.settings-buttons')).not.toBeDisplayed()
    // The form's title is a nested card title: it keeps its own Pliant recipe
    // rather than inheriting the section masthead's 28px display face.
    const formTitle = await readHeadingStyle('.automation-form-title')
    const masthead = await readHeadingStyle('.settings-section.active > h3')
    assert.ok(formTitle && masthead)
    assert.equal(formTitle.tag, 'H4')
    assert.ok(!isDisplayFace(formTitle.family), `form title family: ${formTitle.family}`)
    assert.equal(formTitle.weight, '600')
    assert.ok(formTitle.size < masthead.size)
    await detail.$('.automation-form').scrollIntoView({ block: 'center' })
    await saveElementScreenshot('.automation-form', 'settings-automation-form.png')
    await detail.$('.automation-cancel-btn').click()
    await expect(dialog.$('.settings-buttons')).toBeDisplayed()
  })
})
