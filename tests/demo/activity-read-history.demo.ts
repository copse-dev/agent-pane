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
    const text = await rows.map((row) => row.getText())
    // The stored failure sits inside the window, so it still shows; failures lead.
    expect(text).toHaveLength(4)
    expect(text[0]).toContain('Fix the flaky sandbox test')
    expect(text[1]).toContain('Refactor auth')
    // Written before lastPromptAt existed: it lists from its usage, unopened.
    expect(text[2]).toContain('Port the settings page')
    expect(text[3]).toContain('Update onboarding copy')
    expect(text.join('\n')).not.toContain('Rename the config keys')
    await saveAppScreenshot('activity-read-history.png')
  })
  for (const width of [800, 1600]) {
    it(`keeps recent history visible at ${width}px`, async () => {
      await browser.setWindowSize(width, 900)
      const rows = await $$('#activity-home .activity-row')
      expect(rows).toHaveLength(4)
      const geometry = await browser.execute(() => {
        const pane = document.querySelector('#pane-chat')?.getBoundingClientRect()
        const home = document.querySelector('#activity-home')?.getBoundingClientRect()
        return pane && home ? { left: home.left - pane.left, right: pane.right - home.right } : null
      })
      expect(geometry).not.toBeNull()
      expect(geometry?.left).toBeGreaterThanOrEqual(0)
      expect(geometry?.right).toBeGreaterThanOrEqual(0)
      await saveAppScreenshot(`activity-read-history-${width}.png`)
    })
  }
})
