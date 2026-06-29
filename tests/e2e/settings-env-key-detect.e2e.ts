import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

// Visual eval for the opt-in "Detect existing API keys" control in
// Settings → General. The e2e harness blanks every provider env var (see
// wdio.conf.ts), so the in-app scan runs end-to-end through the real IPC and
// deterministically reports an empty result on CI. The detected-rows / import
// rendering is covered by the component test
// (src/renderer/views/setup/env-key-detect-section.test.ts).
describe('environment API-key detection (Settings → General)', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-env-key-detect')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders the scan control and reports no keys in a clean environment', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await $('[aria-label="Settings"]').click()

    // General is the default section and hosts the env-detect fieldset.
    const general = $('.settings-section[data-section="general"]')
    await expect(general).toBeDisplayed()

    const host = $('#settings-env-detect-host')
    await expect(host.$('legend=Detect existing API keys')).toBeDisplayed()

    const scanBtn = host.$('button=Scan environment')
    await expect(scanBtn).toBeDisplayed()
    // Import button is hidden until a scan finds an importable key.
    await expect(host.$('button=Import keys')).not.toBeDisplayed()

    await saveElementScreenshot('#settings-env-detect-host', 'settings-env-key-detect.png')

    // Clicking Scan is the explicit opt-in; it runs the real scan over the
    // (blanked) environment and reports the empty result.
    await scanBtn.click()
    const status = host.$('.env-key-actions .key-status')
    await browser.waitUntil(
      async () => /no provider keys found/i.test((await status.getText()) ?? ''),
      { timeout: 10_000, timeoutMsg: 'scan never reported a result' },
    )

    assert.equal((await host.$$('.env-key-row')).length, 0)
    await expect(host.$('button=Import keys')).not.toBeDisplayed()
  })
})
