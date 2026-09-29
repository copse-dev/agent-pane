import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-balanced-model-label-project'

describe('Balanced composer model label', () => {
  before(async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID, {
      model: 'auto:balanced',
      subagentsEnabled: false,
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows Balanced without a no-key suffix in the composer', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    const trigger = $('.model-picker-trigger[aria-label="Chat model"]')
    const label = trigger.$('.model-picker-label')
    // Under the mock LLM the selector resolves to a concrete model, and the
    // composer shows that model; the selector's own row must still read as
    // "Balanced" rather than the pinned-id fallback "auto:balanced (no key)".
    await expect(label).toBeDisplayed()
    assert.doesNotMatch(await label.getText(), /no key/i)

    await trigger.click()
    const menu = $('.model-picker-menu')
    await expect(menu).toBeDisplayed()
    const selected = menu.$('.model-picker-option[data-value="auto:balanced"]')
    await expect(selected).toBeDisplayed()
    const selectedText = await selected.getText()
    assert.equal(selectedText, 'Balanced')
    assert.doesNotMatch(selectedText, /no key/i)

    await saveElementScreenshot('.footer-model-host', 'balanced-model-label.png')
  })
})
