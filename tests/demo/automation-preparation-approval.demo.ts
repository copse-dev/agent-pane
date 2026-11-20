import { $, browser, expect } from '@wdio/globals'
import { prepareE2eScreenshot, saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('automation preparation approval', () => {
  it('offers remembering by default and lets the user choose one-time approval', async () => {
    await browser.url('/?scenario=approval-automation-preparation')
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed()
    await prepareE2eScreenshot()
    await expect(dialog.$('.approval-heading')).toHaveText('Prepare this worktree?')
    const remember = dialog.$('.approval-remember-input')
    await expect(remember).toBeSelected()
    await expect(dialog.$('.approval-remember')).toHaveText(
      'Remember for this automation (“Morning caretaker”)',
    )
    await expect(dialog.$('.approval-body-code')).toHaveText(
      'scripts/prepare-native-artifacts.mts',
      { containing: true },
    )
    await saveElementScreenshot('#approval-dialog', 'automation-preparation-approval.png')
    await remember.click()
    await expect(remember).not.toBeSelected()
    await dialog.$('.approval-approve').click()
    await expect(dialog).not.toBeDisplayed()
  })
})
