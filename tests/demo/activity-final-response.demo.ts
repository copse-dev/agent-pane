import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'
import { pinDemoClock } from './helpers/fixed-clock.ts'

// A settled row's detail pane shows what the thread ended with — its last reply,
// read on demand for a thread loaded metadata-only — not the bare word Finished.

describe('Activity home final response', () => {
  before(async () => {
    await pinDemoClock()
    await browser.url('about:blank')
    await browser.url('/?scenario=activity-home-final-response')
    await $('#activity-home .activity-row').waitForExist({ timeout: 30_000 })
  })

  it("shows a failed thread's last response", async () => {
    const reply = $('#activity-home .activity-detail .activity-final-reply')
    await reply.waitForExist({ timeout: 10_000 })
    await expect($('#activity-home .activity-detail-label')).toHaveText('LAST RESPONSE', {
      ignoreCase: true,
    })
    await expect(reply.$('code')).toHaveText('pnpm test -- sandbox')
  })

  it("shows a finished thread's final response as Markdown", async () => {
    await $('#activity-home .activity-row[data-row-key="thread:demo-activity-final-review"]')
      .$('.activity-row-open')
      .click()
    const detail = $(
      '#activity-home .activity-detail[data-row-key="thread:demo-activity-final-review"]',
    )
    const reply = detail.$('.activity-final-reply')
    await reply.waitForExist({ timeout: 10_000 })
    await expect(detail.$('.activity-detail-label')).toHaveText('FINAL RESPONSE', {
      ignoreCase: true,
    })
    await expect(reply.$$('li')).toBeElementsArrayOfSize(3)
    await expect(reply).toHaveText(expect.stringContaining('Nothing else is waiting on you.'))
    await expect(detail.$('.activity-detail-text')).not.toBeExisting()
    await saveAppScreenshot('activity-final-response.png')
  })
})
