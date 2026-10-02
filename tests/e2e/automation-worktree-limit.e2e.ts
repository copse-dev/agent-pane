import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { BEST_VALUE_CHAT_MODEL } from '../../src/shared/lm-studio-defaults.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-automation-worktree-limit'
const SCHEDULE_ID = 'schedule-blocked'
const PROJECT_MENU = `.project-entry[data-project-id="${PROJECT_ID}"] .project-menu-btn`

describe('automation worktree limit in the project modal', function () {
  this.timeout(60_000)

  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID, { model: BEST_VALUE_CHAT_MODEL })
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
                name: 'Thread proposal from backlog',
                cron: '0 0 1 1 *',
                prompt: 'Propose a thread from the backlog.',
                model: BEST_VALUE_CHAT_MODEL,
                enabled: true,
                maxLiveWorktrees: 1,
                createdAt: 1_786_000_000_000,
                updatedAt: 1_786_000_000_000,
                lastRunAt: 1_786_000_000_000,
                lastWorktreeLimitAt: 1_790_000_000_000,
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

  it('shows the skipped run and saves a higher limit from the modal', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $(PROJECT_MENU).click()
    await $('.context-menu-item=Automations').click()
    const dialog = $('#automation-dialog')
    await expect(dialog).toBeDisplayed()
    const attention = dialog.$('.automation-attention')
    await expect(attention).toBeDisplayed()
    assert.match(
      await attention.getText(),
      /1 automation had a run skipped at the live worktree limit/,
    )
    const row = dialog.$(`.automation-row[data-schedule-id="${SCHEDULE_ID}"]`)
    await expect(row).toHaveElementClass('automation-row-blocked')
    assert.match(await row.$('.automation-row-blocked-message').getText(), /Last attempt skipped/)
    await saveAppScreenshot('automation-worktree-limit-blocked.png')

    await row.$('.automation-row-btn=Edit').click()
    await expect(dialog.$('.automation-worktree-limit-select')).toHaveValue('1')
    await dialog.$('.automation-worktree-limit-select').selectByAttribute('value', '2')
    await dialog.$('.automation-save-btn').click()
    await expect(dialog.$('.automation-form')).not.toBeDisplayed()
    await expect(dialog.$('.automation-row-meta')).toHaveText(
      expect.stringContaining('2 live worktrees max'),
    )
    await expect(attention).not.toBeDisplayed()
    await saveAppScreenshot('automation-worktree-limit-updated.png')

    await dialog.$('[aria-label="Close automations"]').click()
    await $(PROJECT_MENU).click()
    await $('.context-menu-item=Automations').click()
    await expect(dialog.$('.automation-row-meta')).toHaveText(
      expect.stringContaining('2 live worktrees max'),
    )
    await expect(dialog.$('.automation-attention')).not.toBeDisplayed()
  })
})
