import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

describe('Parallel Search pack settings', function () {
  this.timeout(60_000)

  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-parallel-search-pack')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows direct API credentials, mode, and the ZDR boundary', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()
    await dialog.$('button[data-section="packs"]').click()

    const row = dialog.$('.pack-row[data-pack-id="copse.parallel-search"]')
    await row.waitForExist({ timeout: 15_000 })
    await row.scrollIntoView({ block: 'center' })
    assert.equal(await row.getAttribute('data-enabled'), 'false')
    assert.equal(await row.$('select[data-setting-key="mode"]').getValue(), 'basic')
    await expect(row.$('input[name="parallelKey"][type="password"]')).toBeExisting()
    await expect(row.$('.parallel-search-save-btn')).toBeExisting()
    await expect(row.$('.parallel-search-clear-btn')).toBeExisting()

    const text = await row.getText()
    assert.match(text, /no MCP server/i)
    assert.match(text, /Search objectives and queries leave this device/i)
    assert.match(text, /Zero Data Retention is not implied/i)
    assert.match(text, /account or contract/i)

    // Capture the configured (enabled) state at normal opacity while retaining
    // the default-off assertion above.
    await row.$('label.pack-toggle').click()
    await browser.waitUntil(async () => (await row.getAttribute('data-enabled')) === 'true', {
      timeout: 5_000,
      timeoutMsg: 'expected Parallel Search pack to enable',
    })
    await browser.execute(() => {
      document
        .querySelector('.parallel-search-pack-settings')
        ?.scrollIntoView({ block: 'center', inline: 'nearest' })
    })
    await expect(row.$('.parallel-search-pack-settings')).toBeDisplayed()
    await saveElementScreenshot('.parallel-search-pack-settings', 'parallel-search-pack.png')
  })
})
