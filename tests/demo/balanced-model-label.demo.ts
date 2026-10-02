import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('browser-hosted Balanced model label', () => {
  before(async () => {
    await browser.url('/?scenario=balanced-model-label')
    await $('.prompt-input').waitForExist()
  })

  it('shows the selected rule by purpose instead of as a model missing a key', async () => {
    const picker = $('.footer-model-host .model-picker')
    const trigger = picker.$('.model-picker-trigger')
    await expect(trigger.$('.model-picker-label')).toHaveText('Balanced')

    await trigger.click()
    const selected = picker.$('.model-picker-option[data-value="auto:balanced"]')
    await expect(selected).toBeDisplayed()
    assert.equal((await selected.getText()).trim(), 'Balanced')
    assert.equal(await selected.getAttribute('aria-current'), 'true')
    assert.doesNotMatch(await picker.$('.model-picker-menu').getText(), /no key/i)

    await saveElementScreenshot('.footer-model-host .model-picker-menu', 'balanced-model-label.png')
  })
})
