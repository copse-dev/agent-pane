import assert from 'node:assert/strict'
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
  it('offers optional backup and requires acknowledgement before skipping it', async () => {
    await openVault('vault-setup')
    const section = $('.profile-vault-section')
    await expect(section).toHaveAttribute('data-state', 'disabled')
    const choices = section.$$('input[type="checkbox"]')
    const backup = choices[0]
    const acknowledge = choices[1]
    assert.ok(backup && acknowledge)
    assert.equal(await backup.isSelected(), true)
    assert.equal(await acknowledge.isDisplayed(), false)
    await backup.click()
    assert.equal(await acknowledge.isDisplayed(), true)
    const enable = section.$('button=Enable encryption')
    await expect(enable).toBeDisabled()
    await acknowledge.click()
    await expect(enable).toBeEnabled()
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
  it('shows verified recovery and makes the restart effect explicit', async () => {
    await openVault('vault-verified')
    const section = $('.profile-vault-section')
    await expect(section).toHaveText(
      expect.stringContaining('Recovery key verified for this profile key.'),
    )
    await expect(section.$('button=Lock and restart')).toBeDisplayed()
    await expect(section).toHaveText(
      expect.stringContaining('A recovery key cannot restore deleted files.'),
    )
    await saveElementScreenshot('#settings-dialog', 'settings-vault-verified.png')
  })
})
