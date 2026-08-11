import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

async function openPacksSection(): Promise<WebdriverIO.Element> {
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
  const dialog = $('#settings-dialog')
  // Idempotent: clicking the trigger while the dialog is already up lands on the
  // settings nav instead ("element click intercepted: … <nav class='settings-nav'>
  // would receive the click"), so a case that leaves the dialog open takes the
  // next one down with it.
  if (!(await dialog.isDisplayed())) {
    await $('[aria-label="Settings"]').click()
    await expect(dialog).toBeDisplayed()
  }
  await dialog.$('button[data-section="customise"]').click()
  const row = dialog.$('.plugin-row[data-plugin-id="copse.parallel-search"]')
  await row.waitForExist({ timeout: 15_000 })
  await row.scrollIntoView({ block: 'center' })

  // Everything configurable about a pack folds into a `<details>` that starts
  // closed (settings-dialog.ts, "Pack settings"). Its contents still *exist*
  // while it is shut, so `toBeExisting()` on the mode select and the key input
  // passes either way — only `getText()`, which returns rendered text, notices.
  // That is why this spec failed on the copy assertions alone, with the observed
  // text ending at the fold's own summary label.
  const fold = row.$('details.plugin-settings-fold')
  await fold.waitForExist({ timeout: 15_000 })
  if (!(await fold.getProperty('open'))) {
    await fold.$('summary.plugin-settings-summary').click()
  }
  await browser.waitUntil(async () => Boolean(await fold.getProperty('open')), {
    timeout: 10_000,
    timeoutMsg: 'the pack settings fold never opened',
  })
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

    // The notice lives inside the collapsed "Pack settings" fold (#1557), and
    // `getText()` returns only *visible* text — so it read the manifest blurb
    // and never the notice. Set `open` rather than clicking the summary: the
    // three tests here share one dialog, so a click would shut a fold that an
    // earlier test had already opened.
    await browser.execute(() => {
      const fold = document.querySelector<HTMLDetailsElement>(
        '.pack-row[data-pack-id="copse.parallel-search"] .pack-settings-fold',
      )
      if (fold) fold.open = true
    })
    await expect(row.$('.parallel-search-notice')).toBeDisplayed()

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
    // Re-open the fold: enabling the plugin rebuilds
    // the whole list (`listEl.innerHTML = ''`), so the `<details>` that
    // `openPacksSection()` opened no longer exists and its replacement starts
    // closed. Guard on `open` rather than clicking blind — `<details>` has no
    // "open it" click, only "flip it", so an unguarded click shuts the fold on
    // any run where the rebuild has not landed by the time we get here.
    const settingsFold = row.$('details.plugin-settings-fold')
    await settingsFold.waitForExist({ timeout: 15_000 })
    if (!(await settingsFold.getProperty('open'))) {
      await settingsFold.$('summary.plugin-settings-summary').click()
    }
    await browser.waitUntil(async () => Boolean(await settingsFold.getProperty('open')), {
      timeout: 10_000,
      timeoutMsg: 'the plugin settings fold never re-opened after enabling the plugin',
    })
    await browser.execute(() => {
      document
        .querySelector('.parallel-search-plugin-settings')
        ?.scrollIntoView({ block: 'center', inline: 'nearest' })
    })
    await expect(row.$('.parallel-search-plugin-settings')).toBeDisplayed()
    await saveElementScreenshot('.parallel-search-plugin-settings', 'parallel-search-plugin.png')
  })
})
