import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('Computer use app approvals', () => {
  it('names the app, the action and the saved grant', async () => {
    await browser.url('/?scenario=approval-desktop-app')
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed()
    await expect(dialog).toHaveText(expect.stringContaining('Let the agent use com.apple.Notes?'))
    await expect(dialog.$('.approval-body')).toHaveText('com.apple.Notes')
    await expect(dialog.$('.approval-advice')).toHaveText(
      expect.stringContaining('read its window contents'),
    )
    await expect(dialog.$('.approval-footer')).toHaveText(
      expect.stringContaining('saved in Settings'),
    )
    await expect(dialog.$('.approval-approve')).toHaveText('Allow for this thread')
    await expect(dialog).toHaveText(expect.stringContaining('Always allow com.apple.Notes'))
    await saveElementScreenshot('#approval-dialog', 'approval-desktop-app.png')
  })

  it('warns that Finder can launch code and offers no always-allow', async () => {
    await browser.url('/?scenario=approval-desktop-finder')
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed()
    await expect(dialog.$('.approval-advice')).toHaveText(
      expect.stringContaining('outside the shell permission gate'),
    )
    await expect(dialog.$('.approval-footer')).toHaveText(
      expect.stringContaining('cannot be always allowed'),
    )
    await expect(dialog).not.toHaveText(expect.stringContaining('Always allow com.apple.finder'))
    await saveElementScreenshot('#approval-dialog', 'approval-desktop-finder.png')
  })
})
