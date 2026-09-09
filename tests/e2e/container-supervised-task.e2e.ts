import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, writeSeedSupervisedTask } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

// The operational row and its existing cancellation action need no Docker or model.
// A blocked task can survive reconciliation and remains explicitly cancellable.
describe('container run in the supervisor rail', function () {
  this.timeout(60_000)
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-container-supervisor')
    writeSeedSupervisedTask({
      taskId: 'blocked-container',
      projectId: 'e2e-container-supervisor',
      threadId: 'thread-1',
      handler: 'container_run',
      provenance: 'user',
      state: 'blocked',
      createdAt: 1,
      updatedAt: 1,
      trigger: { kind: 'immediate' },
      permissionSnapshot: {
        capturedAt: 1,
        autoRunSandboxCommands: false,
        projectSandboxEnabled: false,
      },
      reapproveOnWake: true,
      concurrencyClass: 'container_run',
      attempt: 1,
      maxAttempts: 1,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })
  after(() => resetUserData())

  it('shows the container task and removes it after cancellation', async () => {
    await $('button[aria-label="Open terminal"]').click()
    const row = $('.supervised-task-row[data-task-id="blocked-container"]')
    await row.waitForDisplayed({ timeout: 15_000 })
    await expect(row.$('.supervised-task-label')).toHaveText('container run')
    await expect(row).toHaveAttribute('data-state', 'blocked')
    await expect(row.$('.supervised-task-cancel')).toHaveAttribute(
      'aria-label',
      'Cancel container run',
    )
    await saveAppScreenshot('container-supervised-task.png')
    await row.$('.supervised-task-cancel').click()
    await row.waitForExist({ reverse: true, timeout: 15_000 })
    await expect($('.supervised-tasks-section')).toHaveAttribute('hidden')
  })
})
