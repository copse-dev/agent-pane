import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, $$, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

/**
 * Settings → About reads the licence report `pnpm build` writes into
 * dist/resources/licenses, so this runs against the real report: hundreds of
 * components, bundled (noVNC) and vendored (gortex, Electron) alike.
 */
describe('Settings → About', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-about')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('lists every shipped component with its licence', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await $('[aria-label="Settings"]').click()
    const navBtn = $('.settings-nav-btn[data-section="about"]')
    await expect(navBtn).toBeDisplayed()
    await navBtn.click()

    const about = $('.settings-section[data-section="about"]')
    await expect(about).toBeDisplayed()
    await browser.waitUntil(async () => (await $$('.about-licenses-list > li').length) > 100, {
      timeout: 15_000,
      timeoutMsg: 'the licence report never rendered its components',
    })

    // A packaged app reports package.json's version. An unpackaged macOS run
    // reports either the patched dev-bundle version or Electron's bundle version
    // when generated icon assets have not been installed into the shared cache.
    const version = await about.$('.about-version').getText()
    assert.match(version, /^(?:dev-[0-9a-f]+|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/)

    const idOf = async (name: string): Promise<string> =>
      about.$(`li[data-search^="${name} "] .about-license-id`).getText()
    assert.equal(await idOf('@novnc/novnc'), 'MPL-2.0')
    assert.equal(await idOf('electron'), 'MIT')
    assert.equal(await idOf('gortex'), 'Apache-2.0')

    // Opening a row builds its licence text in place.
    const novnc = about.$('li[data-search^="@novnc/novnc "]')
    await novnc.$('summary').click()
    await expect(novnc.$('.about-license-text')).toBeDisplayed()
    // Its root LICENSE.txt is only a summary; the full MPL-2.0 text is in docs/,
    // and the pako it bundles brings its own MIT licence.
    const fileNames = await novnc.$$('.about-license-file-name').map((el) => el.getText())
    assert.ok(fileNames.includes('docs/LICENSE.MPL-2.0'), fileNames.join(', '))
    assert.ok(fileNames.includes('vendor/pako/LICENSE'), fileNames.join(', '))
    assert.match(
      await novnc.$('.about-license-body').getText(),
      /Mozilla Public License Version 2\.0/,
    )

    const filter = about.$('.about-licenses-filter')
    await filter.setValue('novnc')
    await browser.waitUntil(
      async () => (await $$('.about-licenses-list > li:not([hidden])').length) === 1,
      { timeout: 5_000, timeoutMsg: 'filtering by "novnc" did not leave one row' },
    )
    assert.match(await about.$('.about-licenses-status').getText(), /^1 of \d+ components$/)

    await saveElementScreenshot('#settings-dialog', 'settings-about.png')
  })
})
