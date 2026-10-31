import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const FIELDSET =
  '.settings-section[data-section="experimental"] fieldset:has(input[name="planModeEnabled"])'
const PLAN_BUTTON = '[data-testid="open-plan"]'

async function openExperimental(): Promise<void> {
  await $('[aria-label="Settings"]').click()
  await $('#settings-dialog').waitForDisplayed()
  await $('#settings-dialog button[data-section="experimental"]').click()
  await $(FIELDSET).scrollIntoView({ block: 'center' })
}

describe('experimental plan mode setting', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-plan-mode')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('hides Start planning until the user opts in', async function () {
    this.timeout(120_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $(PLAN_BUTTON).waitForExist({ timeout: 30_000 })
    await expect($(PLAN_BUTTON)).not.toBeDisplayed()

    await openExperimental()
    const toggle = $('input[name="planModeEnabled"]')
    await expect(toggle).not.toBeSelected()
    const hint = (await $(FIELDSET).$('.field-hint').getText()).replace(/\s+/g, ' ')
    assert.match(hint, /living plan with explicit steps and acceptance criteria/)
    assert.match(hint, /not a verified check/)
    await saveElementScreenshot(FIELDSET, 'settings-plan-mode-off.png')

    await toggle.click()
    await $('#settings-dialog .settings-buttons button[type="submit"]').click()
    await $('#settings-dialog').waitForDisplayed({ timeout: 30_000, reverse: true })
    await $(PLAN_BUTTON).waitForDisplayed({ timeout: 30_000 })
    await saveElementScreenshot('.input-footer', 'composer-plan-mode-on.png')
  })
})
