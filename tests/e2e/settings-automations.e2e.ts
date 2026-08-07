import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { AUTOMATIONS_PACK_ID } from '../../packages/agent/src/packs/automations-pack.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-settings-automations'
const SCHEDULE_ID = 'schedule-morning-review'

describe('settings automations pack', function () {
  this.timeout(60_000)

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID, { model: 'claude-sonnet-4-6' })
    // The automations pack has no legacy opt-in, so production seeds it off
    // once. Mark that migration complete and seed the explicit enabled state +
    // pack storage for this visual fixture.
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      [`threads:${PROJECT_ID}`]: [],
      packDisabled: [],
      // electron-store resolves dotted keys through nested config objects.
      packMigration: { automationsEnablement: true },
      pack: {
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

  it('renders project scope, cron, model, and the permission boundary', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()
    await dialog.$('button[data-section="packs"]').click()

    const row = dialog.$(`.pack-row[data-pack-id="${AUTOMATIONS_PACK_ID}"]`)
    await row.waitForExist({ timeout: 15_000 })
    await row.scrollIntoView({ block: 'center' })
    assert.equal(await row.getAttribute('data-enabled'), 'true')
    await expect(row.$('.pack-chip=UI × 1')).toBeDisplayed()

    // The pack's detail panel sits inside its closed "Pack settings" fold.
    await row.$('.pack-settings-summary').click()
    const detail = row.$('.automation-pack-settings')
    await expect(detail).toBeDisplayed()
    assert.match(await detail.getText(), /Project: workspace · local time/)
    assert.match(await detail.getText(), /Weekday project review/)
    assert.match(await detail.getText(), /0 9 \* \* 1-5/)
    assert.match(await detail.getText(), /Claude Sonnet 4\.6/)
    assert.match(await detail.getText(), /Normal tool permission prompts still apply/i)
    await expect(detail.$('.automation-run-btn')).toBeEnabled()

    // Open the editor as well: the screenshot now covers the persisted row and
    // the complete create/edit surface with its dynamic model picker.
    await detail.$('.automation-add-btn').click()
    await expect(detail.$('.automation-form')).toBeDisplayed()
    await expect(detail.$('.automation-form .model-picker-field')).toBeDisplayed()
    await detail.$('.automation-form').scrollIntoView({ block: 'center' })
    await saveElementScreenshot('.automation-pack-settings', 'settings-automations.png')
  })
})
