import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

describe('built-in browser tools setting', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-browser-tools')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows the built-in browser toggle in General, on by default', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await $('[aria-label="Settings"]').click()

    const general = $('.settings-section[data-section="general"]')
    await expect(general).toBeDisplayed()

    const toggle = await general.$('input[name="browserToolsEnabled"]')
    await expect(toggle).toBeExisting()
    // On by default: the agent uses the bundled browser instead of installing one.
    assert.equal(await toggle.isSelected(), true)

    await browser.execute(() => {
      const input = document.querySelector<HTMLElement>('input[name="browserToolsEnabled"]')
      input?.closest('fieldset')?.scrollIntoView()
    })
    await browser.pause(100)
    await saveElementScreenshot('#settings-dialog', 'settings-browser-tools.png')
  })
})
