import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { BEST_VALUE_CHAT_MODEL } from '../../src/shared/lm-studio-defaults.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-automation-trigger-problem'
const PROJECT_MENU = `.project-entry[data-project-id="${PROJECT_ID}"] .project-menu-btn`

function schedule(id: string, name: string, lastProblem?: Record<string, unknown>): object {
  return {
    id,
    projectId: PROJECT_ID,
    name,
    cron: '0 0 1 1 *',
    prompt: 'Check project health.',
    model: BEST_VALUE_CHAT_MODEL,
    enabled: true,
    maxLiveWorktrees: 1,
    createdAt: 1_786_000_000_000,
    updatedAt: 1_786_000_000_000,
    ...(lastProblem ? { lastProblem } : {}),
  }
}

describe('automation trigger problems in the project modal', function () {
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
              schedule('failed', 'Nightly triage', {
                at: 1_790_000_000_000,
                kind: 'failed',
                message: 'disk unavailable',
              }),
              schedule('pending', 'Morning review', {
                at: 1_790_000_060_000,
                kind: 'pending-start',
                message: 'An earlier run was created but never started, so this one was skipped.',
              }),
              schedule('healthy', 'Weekly digest'),
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

  it('says why the latest attempt did not run, only on the schedules that had a problem', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $(PROJECT_MENU).click()
    await $('.context-menu-item=Automations').click()
    const dialog = $('#automation-dialog')
    await expect(dialog).toBeDisplayed()

    const failed = dialog.$('.automation-row[data-schedule-id="failed"]')
    await expect(failed).toHaveElementClass('automation-row-blocked')
    const failedText = await failed.$('.automation-row-problem-message').getText()
    assert.match(failedText, /Last attempt failed/)
    assert.match(failedText, /disk unavailable/)

    const pending = dialog.$('.automation-row[data-schedule-id="pending"]')
    const pendingText = await pending.$('.automation-row-problem-message').getText()
    assert.match(pendingText, /Last attempt skipped/)
    assert.match(pendingText, /never started/)

    const healthy = dialog.$('.automation-row[data-schedule-id="healthy"]')
    await expect(healthy).not.toHaveElementClass('automation-row-blocked')
    await expect(healthy.$('.automation-row-problem-message')).not.toExist()
    await saveAppScreenshot('automation-trigger-problem.png')
  })
})
