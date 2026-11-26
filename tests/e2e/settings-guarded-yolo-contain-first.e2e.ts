import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'

const FIELDSET =
  '.settings-section[data-section="permissions"] fieldset:has(input[name="guardedYoloContainFirst"])'

async function openPermissions(): Promise<void> {
  await $('[aria-label="Settings"]').click()
  await $('#settings-dialog').waitForDisplayed()
  await $('#settings-dialog button[data-section="permissions"]').click()
  await $(FIELDSET).scrollIntoView({ block: 'center' })
}

describe('Guarded YOLO contain-first setting', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), 'e2e-settings-guarded-yolo-contain-first')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('defaults off, states the trade-off, and saves opting in', async function () {
    this.timeout(120_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await openPermissions()
    const toggle = (): ReturnType<typeof $> => $('input[name="guardedYoloContainFirst"]')
    await expect(toggle()).not.toBeSelected()
    assert.equal((await $(FIELDSET).$('legend').getText()).trim(), 'Guarded YOLO')
    const hint = (await $(FIELDSET).$('.field-hint').getText()).replace(/\s+/g, ' ')
    assert.match(hint, /Off by default/)
    assert.match(hint, /The cost is more prompts/)
    assert.match(hint, /trusted list still run outside without asking/)
    assert.match(hint, /Without the project sandbox .* ask before they run instead/)
    assert.match(hint, /coding agents you add from outside Copse/)

    await toggle().click()
    await expect(toggle()).toBeSelected()
    await saveElementScreenshot(FIELDSET, 'settings-guarded-yolo-contain-first.png')
    await $('#settings-dialog .settings-buttons button[type="submit"]').click()
    await $('#settings-dialog').waitForDisplayed({ timeout: 30_000, reverse: true })
    const stored = await browser.execute(() => window.api.settings.get('guardedYoloContainFirst'))
    assert.equal(stored, true)
  })
})
