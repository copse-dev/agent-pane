import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedOpenRouterFixture } from './helpers/seed-config.ts'

describe('OpenRouter model picker', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedOpenRouterFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('lists the curated shortlist and custom model in an OpenRouter group', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })

    // Open the footer model picker menu.
    await $('.model-picker-trigger').click()
    await $('.model-picker-menu .model-picker-option').waitForExist({ timeout: 15_000 })

    const picker = await browser.execute(() => {
      const groupLabels = [
        ...document.querySelectorAll<HTMLElement>('.model-picker-group-label'),
      ].map((el) => el.textContent?.trim())
      const optionLabels = [
        ...document.querySelectorAll<HTMLButtonElement>('.model-picker-menu .model-picker-option'),
      ].map((el) => ({ label: el.textContent?.trim() ?? '', disabled: el.disabled }))
      return { groupLabels, optionLabels }
    })

    assert.ok(
      picker.groupLabels.includes('OpenRouter'),
      `expected an OpenRouter group, saw ${JSON.stringify(picker.groupLabels)}`,
    )
    // Curated shortlist entry, enabled because the fixture seeds an OpenRouter key.
    const gpt4o = picker.optionLabels.find((o) => o.label === 'GPT-4o')
    assert.ok(gpt4o, `expected a curated GPT-4o option, saw ${JSON.stringify(picker.optionLabels)}`)
    assert.equal(gpt4o.disabled, false)
    // Custom model typed in Settings appears alongside the shortlist.
    assert.ok(
      picker.optionLabels.some((o) => o.label === 'x-ai/grok-2 (custom)'),
      `expected the custom OpenRouter model, saw ${JSON.stringify(picker.optionLabels)}`,
    )

    await saveElementScreenshot('.model-picker-menu', 'openrouter-model-picker-menu.png')
  })

  it('exposes an OpenRouter API key field and custom model input in Settings', async () => {
    // Close the picker, then open Settings.
    await browser.keys('Escape')
    await $('[aria-label="Settings"]').click()
    await $('.settings-section[data-section="general"]').waitForExist({ timeout: 15_000 })

    const fields = await browser.execute(() => {
      const hasOpenRouterKey = !!document.querySelector('input[name="openrouterKey"]')
      const hasCustomModel = !!document.querySelector('input[name="openRouterModel"]')
      const customModelValue =
        document.querySelector<HTMLInputElement>('input[name="openRouterModel"]')?.value ?? ''
      return { hasOpenRouterKey, hasCustomModel, customModelValue }
    })

    assert.equal(fields.hasOpenRouterKey, true)
    assert.equal(fields.hasCustomModel, true)
    assert.equal(fields.customModelValue, 'x-ai/grok-2')

    await saveElementScreenshot('#settings-dialog', 'openrouter-settings-fields.png')
  })
})
