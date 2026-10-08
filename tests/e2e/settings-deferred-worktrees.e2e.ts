import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const FIELDSET =
  '.settings-section[data-section="experimental"] fieldset:has(input[name="deferredWorktreesEnabled"])'

async function openExperimental(): Promise<void> {
  await $('[aria-label="Settings"]').click()
  await $('#settings-dialog').waitForDisplayed()
  await $('#settings-dialog button[data-section="experimental"]').click()
  await $(FIELDSET).scrollIntoView({ block: 'center' })
}

async function saveAndRestart(): Promise<void> {
  await $('#settings-dialog .settings-buttons button[type="submit"]').click()
  await $('#settings-dialog').waitForDisplayed({ timeout: 30_000, reverse: true })
  await browser.reloadSession()
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
  await openExperimental()
}

describe('Copse-wide deferred worktrees setting', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-deferred-worktrees')
    await browser.reloadSession()
  })

  after(() => resetUserData())

  it('defaults off and persists opting in and out across restarts', async function () {
    this.timeout(120_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await openExperimental()
    const toggle = () => $('input[name="deferredWorktreesEnabled"]')
    await expect(toggle()).not.toBeSelected()
    const hint = (await $(FIELDSET).$('.field-hint').getText()).replace(/\s+/g, ' ')
    assert.match(hint, /Applies across Copse to new threads using automatic checkout/)
    assert.match(hint, /before writing/)
    assert.match(hint, /agents installed on this device still create one up front/)
    await saveElementScreenshot(FIELDSET, 'settings-deferred-worktrees-off.png')

    await toggle().click()
    await saveAndRestart()
    await expect(toggle()).toBeSelected()
    await saveElementScreenshot(FIELDSET, 'settings-deferred-worktrees-on.png')

    await toggle().click()
    await saveAndRestart()
    await expect(toggle()).not.toBeSelected()
  })
})
