import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('browser-hosted Balanced choice without usage charges', () => {
  before(async () => {
    await browser.url('/?scenario=settings-footer')
    await $('.prompt-input').waitForExist()
    await $('[aria-label="Settings"]').click()
    await $('.settings-section[data-section="general"]').waitForDisplayed()
  })

  it('offers and saves the no-charge rule as the chat default', async () => {
    const picker = $('[data-model-picker-for="model"]')
    await picker.scrollIntoView({ block: 'center' })
    await picker.$('.model-picker-trigger').click()

    const option = picker.$('.model-picker-option[data-value="auto:balanced-included"]')
    await expect(option).toBeDisplayed()
    await expect(option).toHaveText(expect.stringContaining('Balanced (no usage charges)'))
    await expect(option).toHaveText(expect.stringContaining('zero-priced routes'))
    await saveElementScreenshot('#settings-dialog', 'settings-balanced-included-choice.png')

    await option.click()
    assert.equal(await $('select[name="model"]').getValue(), 'auto:balanced-included')
    await expect(picker.$('.model-picker-trigger')).toHaveText(
      expect.stringContaining('Balanced (no usage charges)'),
    )
    await saveElementScreenshot('#settings-dialog', 'settings-balanced-included-selected.png')

    await $('#settings-dialog button[type="submit"]').click()
    await $('#settings-dialog').waitForDisplayed({ reverse: true })
    await $('[aria-label="Settings"]').click()
    await expect($('[data-model-picker-for="model"] .model-picker-trigger')).toHaveText(
      expect.stringContaining('Balanced (no usage charges)'),
    )
  })
})
