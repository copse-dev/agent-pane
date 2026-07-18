import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

describe('read terminal setting', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-read-terminal')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows the Shells read toggle in General, on by default', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await $('[aria-label="Settings"]').click()

    const general = $('.settings-section[data-section="general"]')
    await expect(general).toBeDisplayed()

    const toggle = await general.$('input[name="readTerminalEnabled"]')
    await expect(toggle).toBeExisting()
    assert.equal(await toggle.isSelected(), true)

    await browser.execute(() => {
      const input = document.querySelector<HTMLElement>('input[name="readTerminalEnabled"]')
      input?.closest('fieldset')?.scrollIntoView()
    })
    await browser.pause(100)
    await saveElementScreenshot('#settings-dialog', 'settings-read-terminal.png')
  })
})
