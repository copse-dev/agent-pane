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
  await dialog.$('button[data-section="plugins"]').click()
  const row = dialog.$('.plugin-row[data-plugin-id="copse.parallel-search"]')
  await row.waitForExist({ timeout: 15_000 })
  await row.scrollIntoView({ block: 'center' })
  return row
}

describe('Parallel Search plugin settings', function () {
  this.timeout(60_000)

  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-parallel-search-plugin')
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
    const toggle = row.$('.plugin-toggle-input')
    // The host registers `parallel_search` only when the plugin is on AND a key
    // resolves, so an on-switch with no key would contribute nothing.
    await browser.waitUntil(async () => !(await toggle.isEnabled()), {
      timeout: 5_000,
      timeoutMsg: 'expected the Parallel Search toggle to be gated on a saved key',
    })
    assert.match(await row.$('.plugin-credential-gate').getText(), /Add a Parallel API key/i)
    assert.equal(await row.getAttribute('data-enabled'), 'false')
  })

  it('enables once a key is stored', async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-parallel-search-plugin', {
      parallelApiKey: 'parallel-e2e-key',
    })
    await browser.reloadSession()

    const row = await openPacksSection()
    const toggle = row.$('.plugin-toggle-input')
    await browser.waitUntil(async () => await toggle.isEnabled(), {
      timeout: 5_000,
      timeoutMsg: 'expected a saved key to un-gate the Parallel Search toggle',
    })
    await expect(row.$('.plugin-credential-gate')).not.toBeDisplayed()

    // Capture the configured (enabled) state at normal opacity while retaining
    // the default-off assertion above.
    await row.$('label.plugin-toggle').click()
    await browser.waitUntil(async () => (await row.getAttribute('data-enabled')) === 'true', {
      timeout: 5_000,
      timeoutMsg: 'expected Parallel Search plugin to enable',
    })
    // The key field sits inside the plugin's closed "Plugin settings" fold.
    await row.$('.plugin-settings-summary').click()
    await browser.execute(() => {
      document
        .querySelector('.parallel-search-plugin-settings')
        ?.scrollIntoView({ block: 'center', inline: 'nearest' })
    })
    await expect(row.$('.parallel-search-plugin-settings')).toBeDisplayed()
    await saveElementScreenshot('.parallel-search-plugin-settings', 'parallel-search-plugin.png')
  })
})
