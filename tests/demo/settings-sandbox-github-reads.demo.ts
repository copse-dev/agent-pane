import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

const FIELDSET = '#settings-dialog fieldset:has(input[name="sandboxGitHubReadsEnabled"])'

/**
 * The Experimental opt-in for GitHub reads inside the project sandbox: off by
 * default, and its hint says what it does and what it does not (writes still
 * ask to leave the sandbox; the command never sees the sign-in; Linux is
 * git-only).
 */
describe('browser-hosted sandboxed GitHub reads setting', () => {
  before(async () => {
    await browser.url('/?scenario=settings-footer')
    await $('.prompt-input').waitForExist()
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').$('button[data-section="experimental"]').click()
    await $('.settings-section[data-section="experimental"]').waitForDisplayed()
  })

  it('defaults off and explains the read-only route', async () => {
    const fieldset = $(FIELDSET)
    await fieldset.scrollIntoView({ block: 'center' })
    await expect(fieldset).toBeDisplayed()
    await expect(fieldset.$('legend')).toHaveText('GitHub reads in the sandbox')
    const toggle = fieldset.$('input[name="sandboxGitHubReadsEnabled"]')
    await expect(toggle).not.toBeSelected()
    const hint = fieldset.$('.field-hint')
    await expect(hint).toHaveText(expect.stringContaining('git fetch'))
    await expect(hint).toHaveText(expect.stringContaining('which the command never sees'))
    await expect(hint).toHaveText(expect.stringContaining('refuses every write'))
    await expect(hint).toHaveText(expect.stringContaining('still ask to run outside the sandbox'))
    await expect(hint).toHaveText(expect.stringContaining('On Linux this covers git only'))
    await saveElementScreenshot(FIELDSET, 'settings-sandbox-github-reads-off.png')

    await fieldset.$('label.checkbox-label').click()
    await expect(toggle).toBeSelected()
    await saveElementScreenshot(FIELDSET, 'settings-sandbox-github-reads-on.png')
  })
})
