import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, writeSeedSupervisedTask } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-supervised-tasks'

describe('supervised task list', function () {
  this.timeout(60_000)

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID)
    writeSeedSupervisedTask({
      taskId: 'waiting-long-task',
      projectId: PROJECT_ID,
      threadId: 'thread-1',
      handler: 'long_horizon_continue',
      provenance: 'agent',
      state: 'waiting',
      createdAt: 1,
      updatedAt: 1,
      trigger: { kind: 'event', event: 'test:continue' },
      permissionSnapshot: {
        capturedAt: 1,
        autoRunSandboxCommands: false,
        projectSandboxEnabled: false,
      },
      reapproveOnWake: false,
      concurrencyClass: 'agent',
      attempt: 0,
      maxAttempts: 1,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('shows and cancels an active supervised task', async () => {
    await browser.execute(() => {
      const body = document.getElementById('body')
      body?.style.setProperty('--projects-width', '180px')
      body?.style.setProperty('--files-width', '360px')
    })
    await $('button[aria-label="Open terminal"]').click()
    const row = $('.supervised-task-row')
    await row.waitForDisplayed({ timeout: 15_000 })
    await expect(row.$('.supervised-task-label')).toHaveText('Long task continuation')
    await expect(row.$('.supervised-task-state')).toHaveText('Waiting')
    await saveAppScreenshot('supervised-tasks-waiting.png')

    await browser.execute(() => {
      document.querySelector<HTMLButtonElement>('.supervised-task-cancel')?.click()
    })
    await row.waitForExist({ reverse: true, timeout: 15_000 })
    await expect($('.supervised-tasks-section')).toHaveAttribute('hidden')
  })
})
