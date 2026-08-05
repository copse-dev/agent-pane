import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

async function openPacksSection(): Promise<WebdriverIO.Element> {
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
  await $('[aria-label="Settings"]').click()
  const dialog = $('#settings-dialog')
  await expect(dialog).toBeDisplayed()
  await dialog.$('button[data-section="packs"]').click()
  const row = dialog.$('.pack-row[data-pack-id="copse.parallel-search"]')
  await row.waitForExist({ timeout: 15_000 })
  await row.scrollIntoView({ block: 'center' })
  return row
}

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
    const row = await openPacksSection()
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
  })

  it('keeps the toggle inert until a Parallel API key is saved', async () => {
    const row = await openPacksSection()
    const toggle = row.$('.pack-toggle-input')
    // The host registers `parallel_search` only when the pack is on AND a key
    // resolves, so an on-switch with no key would contribute nothing.
    await browser.waitUntil(async () => !(await toggle.isEnabled()), {
      timeout: 5_000,
      timeoutMsg: 'expected the Parallel Search toggle to be gated on a saved key',
    })
    assert.match(await row.$('.pack-credential-gate').getText(), /Add a Parallel API key/i)
    assert.equal(await row.getAttribute('data-enabled'), 'false')
  })

  it('enables once a key is stored', async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-parallel-search-pack', {
      parallelApiKey: 'parallel-e2e-key',
    })
    await browser.reloadSession()

    const row = await openPacksSection()
    const toggle = row.$('.pack-toggle-input')
    await browser.waitUntil(async () => await toggle.isEnabled(), {
      timeout: 5_000,
      timeoutMsg: 'expected a saved key to un-gate the Parallel Search toggle',
    })
    await expect(row.$('.pack-credential-gate')).not.toBeDisplayed()

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
