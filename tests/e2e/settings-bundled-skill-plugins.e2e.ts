import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

// Settings → Customise → Plugins, bundled Cursor plugins.
//
// The Cursor plugins that ship inside Copse used to be invisible here: one
// all-or-nothing checkbox under Agent → Skills was the only control. Each now
// gets a row with its own live switch, and pstack — written for Cursor's
// subagents and model names — ships switched off with the reason on the row.
// This spec reaches that state through the real main-process listing and the
// real settings write, and saves the row before and after turning it on.

const PSTACK_ROW = '.plugin-row[data-plugin-origin="bundled"][data-plugin-id="pstack"]'

describe('settings bundled skill plugins', function () {
  this.timeout(60_000)

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-bundled-skill-plugins')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('lists pstack switched off with its reason, and turns it on', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()
    await dialog.$('button[data-section="customise"]').click()

    const row = $(PSTACK_ROW)
    await row.waitForDisplayed({ timeout: 30_000 })
    await row.scrollIntoView({ block: 'center' })
    await expect(row).toHaveAttribute('data-enabled', 'false')
    // The eyebrow is uppercased by CSS; the source text is what a reader hears.
    expect(await row.$('.plugin-badge-cursor').getProperty('textContent')).toBe('Cursor · Bundled')
    await expect(row.$('.plugin-default-off-note')).toHaveText(
      'Off by default. Written for Cursor',
      { containing: true },
    )
    await expect(row.$('.plugin-chip')).toHaveText('36 skills')
    const toggle = row.$('.plugin-toggle-input')
    await expect(toggle).not.toBeChecked()
    await expect(toggle).toBeEnabled()

    // A default-on bundled plugin sits under Active with its switch on.
    const teamKit = $('.plugin-row[data-plugin-origin="bundled"][data-plugin-id="cursor-team-kit"]')
    await expect(teamKit).toHaveAttribute('data-enabled', 'true')

    await saveElementScreenshot(PSTACK_ROW, 'settings-bundled-plugin-pstack-off.png')

    await row.$('.plugin-toggle').click()
    // The list re-renders after the save, so re-query the row.
    await browser.waitUntil(
      async () => (await $(PSTACK_ROW).getAttribute('data-enabled')) === 'true',
      { timeout: 10_000, timeoutMsg: 'pstack row never moved to Active' },
    )
    await expect($(PSTACK_ROW).$('.plugin-toggle-input')).toBeChecked()
    const stored = await browser.execute(() =>
      window.api.settings.get('bundledSkillPluginOverrides'),
    )
    expect(stored).toEqual({ pstack: true })

    await $(PSTACK_ROW).scrollIntoView({ block: 'center' })
    await saveElementScreenshot(PSTACK_ROW, 'settings-bundled-plugin-pstack-on.png')
  })
})
