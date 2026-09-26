import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

    // A packaged app reports package.json's version; the e2e app runs unpackaged
    // from dist/main, where Electron reports the dev bundle's patched version.
    const pkg: unknown = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
    assert.ok(typeof pkg === 'object' && pkg !== null && 'version' in pkg)
    const version = await about.$('.about-version').getText()
    assert.ok(
      version === String(pkg.version) || /^dev-[0-9a-f]+$/.test(version),
      `unexpected version ${version}`,
    )

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
