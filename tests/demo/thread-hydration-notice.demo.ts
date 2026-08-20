import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

// Switching into a thread whose transcript has not been read yet used to show
// an empty pane — just the composer — until the next agent event (#1684). The
// scenario freezes that mid-switch moment (running thread, hydration held
// open) so the notice that now fills it can be asserted and captured.

describe('browser-hosted thread hydration notice', () => {
  before(async () => {
    await browser.url('/?scenario=thread-hydration')
    await $('.conversation-hydrating').waitForExist({ timeout: 30_000 })
  })

  it('says the agent is working while the transcript loads', async () => {
    const notice = $('.conversation-hydrating')
    await expect(notice).toHaveText('Agent is working — loading the conversation…')
    const probe = await browser.execute(() => {
      const noticeEl = document.querySelector('.conversation-hydrating')
      const activity = document.querySelector('.agent-activity')
      if (!(noticeEl instanceof HTMLElement) || !(activity instanceof HTMLElement)) return null
      return {
        running: noticeEl.classList.contains('conversation-hydrating-running'),
        noticeVisible: noticeEl.getBoundingClientRect().height > 0,
        activityHidden: activity.hidden,
      }
    })
    expect(probe).not.toBeNull()
    if (!probe) throw new Error('Missing hydration notice or activity row')
    expect(probe.running).toBe(true)
    expect(probe.noticeVisible).toBe(true)
    // The notice replaces the live activity row until the transcript is in.
    expect(probe.activityHidden).toBe(true)
    await saveAppScreenshot('thread-hydration-running-notice.png')
  })
})
