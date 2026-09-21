import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const FIELDSET_SELECTOR = 'fieldset:has(input[name="shareTerminalHistoryEnabled"])'

async function openPermissions(): Promise<WebdriverIO.Element> {
  await $('[aria-label="Settings"]').click()
  const dialog = $('#settings-dialog')
  await expect(dialog).toBeDisplayed()
  await dialog.$('button[data-section="permissions"]').click()
  const permissions = $('.settings-section[data-section="permissions"]')
  await expect(permissions).toBeDisplayed()
  return permissions
}

describe('shared terminal history setting (#2433)', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-terminal-history')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('is on by default, can be turned off, and the change persists', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const permissions = await openPermissions()

    const toggle = await permissions.$('input[name="shareTerminalHistoryEnabled"]')
    await expect(toggle).toBeExisting()
    // On by default: every terminal opened for a project shares one HISTFILE.
    assert.equal(await toggle.isSelected(), true)
    assert.match(await permissions.getText(), /Share command history across the project/)
    assert.match(
      await permissions.getText(),
      /pressing the up arrow in one thread's Shells tab can recall a\s+command run in another/,
    )

    await browser.execute(() => {
      document
        .querySelector<HTMLElement>('input[name="shareTerminalHistoryEnabled"]')
        ?.closest('fieldset')
        ?.scrollIntoView({ block: 'center' })
    })
    await browser.pause(100)
    await saveElementScreenshot(FIELDSET_SELECTOR, 'settings-terminal-history-toggle.png')

    await toggle.click()
    assert.equal(await toggle.isSelected(), false)

    await browser.execute(() => {
      document
        .querySelector<HTMLElement>('input[name="shareTerminalHistoryEnabled"]')
        ?.closest('fieldset')
        ?.scrollIntoView({ block: 'center' })
    })
    await browser.pause(100)
    await saveElementScreenshot(FIELDSET_SELECTOR, 'settings-terminal-history-toggle-off.png')

    await $('#settings-dialog button[type="submit"]').click()
    // Dialog hides on a successful save.
    await $('#settings-dialog').waitForDisplayed({ timeout: 30_000, reverse: true })

    // Reopen to prove the off state persisted, not just the in-memory checkbox.
    const reopened = await openPermissions()
    const reopenedToggle = await reopened.$('input[name="shareTerminalHistoryEnabled"]')
    await expect(reopenedToggle).toBeExisting()
    assert.equal(await reopenedToggle.isSelected(), false)
  })
})
