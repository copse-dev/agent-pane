import { $, $$, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

// Threads that finished before launch and were already read still list under
// Recently finished, inside the recency window; older ones stay out. Without this the
// Activity home hid itself for a user whose threads were all complete.

describe('Activity home recent history', () => {
  before(async () => {
    await browser.url('about:blank')
    await browser.url('/?scenario=activity-home-read-history')
    await $('#activity-home .activity-row').waitForExist({ timeout: 30_000 })
  })

  it('lists completed threads from before launch, newest first, within the window', async () => {
    const rows = await $$('#activity-home .activity-row')
    const text = await Promise.all(rows.map((row) => row.getText()))
    // The stored failure sits inside the window, so it still shows; failures lead.
    expect(text).toHaveLength(3)
    expect(text[0]).toContain('Fix the flaky sandbox test')
    expect(text[1]).toContain('Refactor auth')
    expect(text[2]).toContain('Update onboarding copy')
    expect(text.join('\n')).not.toContain('Rename the config keys')
    await saveAppScreenshot('activity-read-history.png')
  })
})
