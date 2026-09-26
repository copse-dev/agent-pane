import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

describe('trusted SSH hosts setting', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-trusted-ssh-hosts')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  async function openPermissions(): Promise<WebdriverIO.Element> {
    await $('[aria-label="Settings"]').click()
    const dialog = await $('#settings-dialog')
    await expect(dialog).toBeDisplayed()
    await dialog.$('button[data-section="permissions"]').click()
    return dialog
  }

  it('starts empty, then saves hosts normalized and drops invalid lines', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    let dialog = await openPermissions()
    const hosts = dialog.$('textarea[name="trustedSshHosts"]')
    await expect(hosts).toBeDisplayed()
    assert.equal(await hosts.getValue(), '')
    assert.match(await dialog.getText(), /Trusted SSH hosts/)

    await hosts.setValue('Build-Box.local\n# lab machines\ndev@not-a-host\n10.0.0.5')
    await $('#settings-dialog button[type="submit"]').click()
    await $('#settings-dialog').waitForDisplayed({ timeout: 30_000, reverse: true })

    const stored = await browser.execute(() => window.api.settings.get('trustedSshHosts'))
    assert.deepEqual(stored, ['build-box.local', '10.0.0.5'])

    dialog = await openPermissions()
    const reopened = dialog.$('textarea[name="trustedSshHosts"]')
    assert.equal(await reopened.getValue(), 'build-box.local\n10.0.0.5')
    await reopened.scrollIntoView({ block: 'center' })
    await saveElementScreenshot(
      'label:has(textarea[name="trustedSshHosts"])',
      'settings-trusted-ssh-hosts.png',
    )
  })
})
