import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import type { AutomationSchedule, AutomationTriggerEvent } from '../../src/shared/types'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

const TIMEOUT_MESSAGE =
  'Trigger timed out after 90000ms; any unfinished creation will not start a turn'

// Exercise the shipped manager through its normal API boundary. The scheduler
// units prove the deadline/attempt fencing; this eval proves the resulting
// lastProblem copy wraps legibly and an armed schedule can be retried.
describe('automation trigger timeout recovery', () => {
  before(async () => {
    await browser.url('/?scenario=automation-permissions')
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.execute(async (message) => {
      const projectId = 'demo-automation-permissions-project'
      const existing = (await window.api.automations.list(projectId))[0]
      if (!existing) throw new Error('The automation demo schedule is missing')
      let schedules: AutomationSchedule[] = [
        {
          ...existing,
          enabled: true,
          lastProblem: {
            at: Date.UTC(2026, 9, 18, 9),
            kind: 'failed',
            code: 'unknown',
            message,
          },
        },
      ]
      window.api.automations.list = (): Promise<AutomationSchedule[]> =>
        Promise.resolve(structuredClone(schedules))
      window.api.automations.runNow = (
        retryProjectId,
        scheduleId,
      ): Promise<AutomationTriggerEvent> => {
        const schedule = schedules[0]
        if (!schedule || retryProjectId !== projectId || schedule.id !== scheduleId) {
          throw new Error('Retry targeted a different project or schedule')
        }
        const { lastProblem: _oldFailure, ...recovered } = schedule
        const triggeredAt = Date.UTC(2026, 9, 18, 9, 1)
        schedules = [{ ...recovered, lastRunAt: triggeredAt }]
        return Promise.resolve({
          projectId,
          scheduleId,
          threadId: 'retried-automation-thread',
          triggeredAt,
          disposition: 'started',
        })
      }
    }, TIMEOUT_MESSAGE)
    await $('[aria-label="Settings"]').click()
    const dialog = $('#settings-dialog')
    await dialog.$('button[data-section="customise"]').click()
    const plugin = dialog.$('.plugin-row[data-plugin-id="copse.automations"]')
    await plugin.scrollIntoView({ block: 'center' })
    await plugin.$('.plugin-settings-summary').click()
    await plugin.$('.automation-row').waitForDisplayed()
  })

  it('shows the actual timeout warning without clipping and permits a fresh retry', async () => {
    const row = $('.automation-row')
    await expect(row.$('.automation-problem-message')).toHaveText(TIMEOUT_MESSAGE)
    await expect(row.$('.automation-row-meta')).toHaveText(expect.stringContaining('Armed'))
    await expect(row.$('.automation-run-btn')).toBeEnabled()
    const geometry = await browser.execute(() => {
      const message = document.querySelector('.automation-problem-message')
      const row = document.querySelector('.automation-row')
      if (!(message instanceof HTMLElement) || !(row instanceof HTMLElement)) {
        throw new Error('The timeout message is missing')
      }
      return {
        messageFits: message.scrollWidth <= message.clientWidth,
        rowFits: row.scrollWidth <= row.clientWidth,
        lines:
          message.getBoundingClientRect().height /
          Number.parseFloat(getComputedStyle(message).lineHeight),
      }
    })
    assert.equal(geometry.messageFits, true)
    assert.equal(geometry.rowFits, true)
    assert.ok(geometry.lines >= 1)
    await saveElementScreenshot('.automation-row', 'automation-timeout-retry.png')

    await row.$('.automation-run-btn').click()
    await expect($('.automation-status')).toHaveText('Started “Weekday project review”.')
    await expect($('.automation-row .automation-problem-message')).not.toExist()
    await expect($('.automation-row .automation-run-btn')).toBeEnabled()
    await saveElementScreenshot('.automation-plugin-settings', 'automation-timeout-retried.png')
  })
})
