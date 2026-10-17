import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

// Settings → General: the single "Re-scan" link re-checks agents and reads the
// environment for API keys. The e2e harness blanks every provider env var (see
// wdio.conf.ts), so the scan runs end-to-end through the real IPC and
// deterministically reports nothing new. Imported-key rendering is covered by the
// component test (src/renderer/views/setup/acp-agents-list.test.ts).
describe('Re-scan finds nothing new in a clean environment (Settings → General)', () => {
  const originalHome = process.env['HOME']
  let cleanHome = ''

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    cleanHome = mkdtempSync(join(tmpdir(), 'copse-e2e-env-key-home-'))
    writeE2eEnv({ HOME: cleanHome })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-env-key-detect')
    await browser.reloadSession()
  })

  after(() => {
    writeE2eEnv({ HOME: originalHome })
    resetUserData()
    removeE2eTree(cleanHome)
  })

  it('scans on click and reports the empty result next to the link', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await $('[aria-label="Settings"]').click()
    await expect($('.settings-section[data-section="general"]')).toBeDisplayed()

    // The old separate "Find keys on this Mac" box is gone: one control does both.
    await expect($('#settings-env-detect-host')).not.toExist()
    const list = $('[data-testid="acp-agents-fieldset"]')
    await list.waitForExist({ timeout: 15_000 })
    const status = list.$('[data-testid="acp-scan-status"]')
    await expect(status).toHaveText('')

    // Clicking Re-scan is the explicit opt-in; it runs the real scan over the
    // (blanked) environment and reports the empty result.
    await list.$('button=Re-scan').click()
    await expect(status).toHaveText('Nothing new found', { containing: true })

    await list.scrollIntoView({ block: 'center' })
    await saveElementScreenshot(
      '[data-testid="acp-agents-fieldset"]',
      'settings-env-key-detect.png',
    )
  })
})
