import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { prepareE2eScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

describe('settings usage model value map ZDR filter', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-value-map-zdr')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('filters the value map to zero-retention paths and screenshots the result', async () => {
    // Seed a Fireworks-priced MiniMax so the ZDR filter has something to keep
    // after Anthropic/OpenAI points are hidden.
    await browser.execute(async () => {
      await window.api.settings.saveExtraProvider({
        slug: 'fireworks',
        models: [
          {
            id: 'MiniMaxAI/MiniMax-M3',
            inputPricePerMTok: 0.3,
            outputPricePerMTok: 1.2,
          },
        ],
      })
    })

    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="usage"]').click()
    const fieldset = $('.frontier-fieldset')
    await expect(fieldset).toBeDisplayed()

    const zdrBtn = fieldset.$('button.frontier-zdr-toggle')
    await expect(zdrBtn).toBeDisplayed()
    assert.equal(await zdrBtn.getAttribute('aria-pressed'), 'false')

    const chart = fieldset.$('.frontier-chart svg')
    await expect(chart).toBeDisplayed()
    assert.match(await chart.getText(), /claude-|gpt-/)

    // Settings footer Save/Cancel can cover the control until scrolled into view.
    await fieldset.scrollIntoView()
    await zdrBtn.scrollIntoView()
    await zdrBtn.click()
    await browser.waitUntil(async () => (await zdrBtn.getAttribute('aria-pressed')) === 'true', {
      timeout: 5000,
      timeoutMsg: 'ZDR only toggle did not activate',
    })

    const filteredText = await chart.getText()
    assert.doesNotMatch(filteredText, /claude-opus-4-8|claude-fable-5|gpt-5\.5/)
    assert.match(filteredText, /MiniMax-M3/)
    assert.match(await fieldset.getText(), /ZDR only: hiding/)

    await prepareE2eScreenshot()
    await saveElementScreenshot('.frontier-fieldset', 'settings-usage-value-map-zdr.png')
  })
})
