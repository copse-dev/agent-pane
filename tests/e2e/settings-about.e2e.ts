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

    // A packaged app reports package.json's version. An unpackaged run reports
    // either the patched dev-bundle version or Electron's platform bundle
    // version (`0.0` on the Linux CI bundle) when generated app metadata has not
    // been installed into the shared cache.
    const version = await about.$('.about-version').getText()
    assert.match(version, /^(?:dev-[0-9a-f]+|0\.0|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/)

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

  it('chooses the update channel and explains switching to stable', async () => {
    const about = $('.settings-section[data-section="about"]')
    const updates = about.$('fieldset.about-updates')
    await updates.scrollIntoView({ block: 'start' })
    await expect(updates).toBeDisplayed()
    await expect(updates.$('legend')).toHaveText('Updates')

    // Nothing is saved yet, so the section shows the installed build's own
    // channel. An unpackaged run reports a platform or dev version rather than
    // Copse's (see the test above), so derive it from the version shown.
    const version = await about.$('.about-version').getText()
    const installed = /^\d+\.\d+\.\d+$/.test(version) ? 'stable' : 'beta'
    const select = updates.$('select[name="updateChannel"]')
    const channelValue = (): Promise<string> =>
      browser.execute(
        () =>
          document.querySelector<HTMLSelectElement>('select[name="updateChannel"]')?.value ?? '',
      )
    const savedChannel = (): Promise<unknown> =>
      browser.execute(() => window.api.settings.get('updateChannel'))
    assert.equal(await channelValue(), installed)
    const options = await select.$$('option').map((option) => option.getText())
    assert.deepEqual(options, ['Beta', 'Stable'])
    await expect(updates.$('.field-hint')).toHaveText(
      'Beta gets new features first; switch to Stable and Copse keeps installing betas until the next stable release, then installs only stable releases.',
    )

    await select.selectByAttribute('value', 'beta')
    if (installed === 'stable') {
      await expect(updates.$('.about-update-status')).toHaveText(
        'Copse now updates to beta releases.',
      )
    }
    await browser.waitUntil(async () => (await savedChannel()) === 'beta', {
      timeout: 5_000,
      timeoutMsg: 'choosing Beta was not saved',
    })

    // Switching to Stable saves the choice and says what happens next for
    // this build: at once on a stable build, at the next stable from a beta.
    await select.selectByAttribute('value', 'stable')
    await expect(updates.$('.about-update-status')).toHaveText(
      installed === 'stable'
        ? 'Copse now updates to stable releases only.'
        : 'Copse keeps updating to betas until the next stable release.',
    )
    await browser.waitUntil(async () => (await savedChannel()) === 'stable', {
      timeout: 5_000,
      timeoutMsg: 'choosing Stable was not saved',
    })
    assert.equal(await channelValue(), 'stable')
    await saveElementScreenshot('fieldset.about-updates', 'settings-about-update-channel.png')
  })
})
