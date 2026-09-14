import { $, browser, expect } from '@wdio/globals'
import type { SupervisedTaskMeta } from '../../src/shared/supervisor/task-schema.ts'
import { resetUserData, seedEmptyProject, writeSeedSupervisedTask } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-supervisor-recovery'
const task: SupervisedTaskMeta = {
  taskId: 'interrupted-long-task',
  projectId: PROJECT_ID,
  threadId: 'thread-1',
  handler: 'long_horizon_continue',
  provenance: 'agent',
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
  concurrencyClass: 'agent',
  attempt: 1,
  maxAttempts: 3,
  lastError: 'Execution interrupted by restart; inspect before resuming',
}

describe('supervised task recovery', function () {
  this.timeout(60_000)

  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID)
    writeSeedSupervisedTask(task)
    writeSeedSupervisedTask({
      ...task,
      taskId: 'waiting-long-task',
      state: 'waiting',
      trigger: { kind: 'event', event: 'test:continue' },
      attempt: 0,
      lastError: undefined,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('inspects, cancels, and resumes through the same persisted supervisor lifecycle', async () => {
    await browser.execute(() => {
      document.getElementById('body')?.style.setProperty('--files-width', '500px')
    })
    await $('button[aria-label="Open terminal"]').click()
    const waiting = $('.supervised-task-row[data-task-id="waiting-long-task"]')
    await waiting.waitForDisplayed({ timeout: 15_000 })
    await waiting.$('.supervised-task-cancel').click()
    await waiting.waitForExist({ reverse: true, timeout: 15_000 })

    const interrupted = $('.supervised-task-row[data-task-id="interrupted-long-task"]')
    await interrupted.$('summary').click()
    await expect(interrupted.$('.supervised-task-reason')).toHaveText(task.lastError ?? '')
    await expect(interrupted.$('.supervised-task-detail')).toHaveText(
      expect.stringContaining('Attempt 1 of 3'),
    )
    await expect(interrupted.$('.supervised-task-resume')).toBeDisplayed()
    await saveAppScreenshot('supervised-tasks-resume.png')
    await interrupted.$('.supervised-task-resume').click()
    // The disabled plugin completes the consumer without dispatching a model turn.
    await interrupted.waitForExist({ reverse: true, timeout: 15_000 })
    await expect($('.supervised-tasks-section')).toHaveAttribute('hidden')
  })
})
