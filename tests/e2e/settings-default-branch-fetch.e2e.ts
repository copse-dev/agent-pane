import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const FIELDSET =
  '.settings-section[data-section="permissions"] fieldset:has(input[name="backgroundDefaultBranchFetch"])'

async function openPermissions(): Promise<void> {
  await $('[aria-label="Settings"]').click()
  await $('#settings-dialog').waitForDisplayed()
  await $('#settings-dialog button[data-section="permissions"]').click()
  await $(FIELDSET).scrollIntoView({ block: 'center' })
}

async function saveAndRestart(): Promise<void> {
  await $('#settings-dialog .settings-buttons button[type="submit"]').click()
  await $('#settings-dialog').waitForDisplayed({ timeout: 30_000, reverse: true })
  await browser.reloadSession()
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
  await openPermissions()
}

describe('background default-branch fetch setting', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-default-branch-fetch')
    await browser.reloadSession()
  })

  after(() => resetUserData())

  it('defaults on under Upstream updates and persists opting out across restarts', async function () {
    this.timeout(120_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await openPermissions()
    const toggle = () => $('input[name="backgroundDefaultBranchFetch"]')
    await expect(toggle()).toBeSelected()
    assert.equal((await $(FIELDSET).$('legend').getText()).trim(), 'Upstream updates')
    const hint = (await $(FIELDSET).$('.field-hint').getText()).replace(/\s+/g, ' ')
    assert.match(hint, /your checkout and branches are never changed/)
    assert.match(hint, /ignores the project's Git configuration/)
    await saveElementScreenshot(FIELDSET, 'settings-default-branch-fetch-on.png')

    await toggle().click()
    await saveAndRestart()
    await expect(toggle()).not.toBeSelected()
    await saveElementScreenshot(FIELDSET, 'settings-default-branch-fetch-off.png')

    await toggle().click()
    await saveAndRestart()
    await expect(toggle()).toBeSelected()
  })
})
