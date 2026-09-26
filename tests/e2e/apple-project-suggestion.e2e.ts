import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

// Detection only runs for local projects on macOS, where Xcode can exist.
const describeAppleSuggestion = process.platform === 'darwin' ? describe : describe.skip

const PROJECT_ID = 'e2e-apple-suggestion-project'

describeAppleSuggestion('Apple development suggestion on project open', function () {
  this.timeout(90_000)
  const workspace = mkdtempSync(join(tmpdir(), 'copse-apple-suggestion-'))

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    // An Xcode project directory is all the open-time detection looks for.
    mkdirSync(join(workspace, 'MyApp.xcodeproj'), { recursive: true })
    resetUserData()
    seedEmptyProject(workspace, PROJECT_ID, { theme: 'dark' })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    rmSync(workspace, { recursive: true, force: true })
  })

  it('asks to turn the plugin on the first time an Apple project opens', async () => {
    const dialog = $('#apple-suggestion-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('h2')).toHaveText('Turn on Apple development?')
    await expect(dialog.$('.apple-suggestion-lede')).toHaveText(
      expect.stringContaining('looks like an Apple project'),
    )
    await expect(dialog.$('.plugin-row .plugin-name')).toHaveText('Apple development')
    await expect(dialog.$('.apple-suggestion-accept')).toHaveText('Turn on')
    await expect(dialog.$('.apple-suggestion-not-now')).toHaveText('Not now')
    await expect(dialog.$('.apple-suggestion-dont-ask')).toHaveText("Don't ask for this project")
    await saveAppScreenshot('apple-suggestion-dialog.png')

    await dialog.$('.apple-suggestion-not-now').click()
    await dialog.waitForExist({ reverse: true, timeout: 5_000 })
    await expect($('.apple-suggestion-notice')).not.toBeDisplayed()
  })

  it('reminds once on the next launch and turns the plugin on from the reminder', async () => {
    await browser.reloadSession()
    const notice = $('.apple-suggestion-notice')
    await notice.waitForDisplayed({ timeout: 30_000 })
    await expect(notice.$('.apple-suggestion-notice-text')).toHaveText(
      expect.stringMatching(/^Apple development is off for .+\.$/),
    )
    await expect(notice.$('.apple-suggestion-notice-accept')).toHaveText('Turn on')
    await expect($('#apple-suggestion-dialog')).not.toExist()
    await saveAppScreenshot('apple-suggestion-reminder.png')

    await notice.$('.apple-suggestion-notice-accept').click()
    await notice.waitForDisplayed({ reverse: true, timeout: 5_000 })
    await browser.waitUntil(
      async () =>
        (
          await browser.execute(() =>
            window.api.appleDevelopment.detectProject('e2e-apple-suggestion-project'),
          )
        ).enrolled,
      { timeout: 30_000, timeoutMsg: 'the project was never allowed' },
    )
    const plugins = await browser.execute(() => window.api.plugins.list())
    const apple = plugins.plugins.find((plugin) => plugin.id === 'copse.apple-development')
    assert.equal(apple?.enabled, true)
  })
})
