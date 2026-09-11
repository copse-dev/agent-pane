import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

async function openVault(scenario: string): Promise<void> {
  await browser.url(`/?scenario=${scenario}`)
  await $('.prompt-input').waitForExist()
  await $('[aria-label="Settings"]').click()
  await $('#settings-dialog').$('button[data-section="storage"]').click()
  await $('.profile-vault-section').waitForDisplayed()
}
describe('saved-secret encryption settings', () => {
  it('explains a deferred automatic migration and offers retry', async () => {
    await openVault('vault-setup')
    const section = $('.profile-vault-section')
    await expect(section).toHaveAttribute('data-state', 'disabled')
    await expect(section).toHaveText(
      expect.stringContaining('Automatic migration could not finish.'),
    )
    await expect(section.$('button=Retry migration')).toBeDisplayed()
    await expect(section.$('button=Enable encryption')).not.toExist()
    await saveElementScreenshot('#settings-dialog', 'settings-vault-setup.png')
  })
  it('shows a locked vault and keeps native authentication out of the browser', async () => {
    await openVault('vault-locked')
    const section = $('.profile-vault-section')
    await expect(section).toHaveText(expect.stringContaining('Recovery key not backed up.'))
    await section.$('button=Unlock').click()
    await expect(section).toHaveText(
      expect.stringContaining('Native authentication requires the desktop app.'),
    )
    await expect(section).toHaveAttribute('data-state', 'locked')
    await expect(section.$('input[type="password"]')).not.toExist()
    await saveElementScreenshot('#settings-dialog', 'settings-vault-locked.png')
  })
  it('shows verified recovery without a separate lock action', async () => {
    await openVault('vault-verified')
    const section = $('.profile-vault-section')
    await expect(section).toHaveText(
      expect.stringContaining('Recovery key verified for this profile key.'),
    )
    await expect(section.$('button=Lock and restart')).not.toExist()
    await expect(section.$('button=Unlock')).not.toExist()
    await expect(section.$('button=Back up recovery key')).toBeDisplayed()
    await expect(section).toHaveText(expect.stringContaining('until you quit.'))
    await expect(section.$('input[type=checkbox]')).not.toBeSelected()
    await expect(section).toHaveText(
      expect.stringContaining('Exporting a recovery key always requires authentication.'),
    )
    await expect(section).toHaveText(
      expect.stringContaining('A recovery key cannot restore deleted files.'),
    )
    await saveElementScreenshot('#settings-dialog', 'settings-vault-verified.png')
  })
})
