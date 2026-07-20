import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { prepareE2eScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

describe('settings usage model value map cost axis', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-value-map-cost')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('toggles the value map between $/MTok and AA $/task and screenshots both', async () => {
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="usage"]').click()
    const fieldset = $('.frontier-fieldset')
    await expect(fieldset).toBeDisplayed()
    await expect(fieldset.$('legend')).toHaveText('Model value map')

    const blendedBtn = fieldset.$('button.frontier-cost-axis-btn[data-cost-axis="blended"]')
    const taskBtn = fieldset.$('button.frontier-cost-axis-btn[data-cost-axis="perTask"]')
    await expect(blendedBtn).toBeDisplayed()
    await expect(taskBtn).toBeDisplayed()
    assert.equal(await taskBtn.getAttribute('disabled'), null)

    const chart = fieldset.$('.frontier-chart svg')
    await expect(chart).toBeDisplayed()
    assert.equal(await chart.getAttribute('data-cost-axis'), 'blended')
    assert.match(await chart.getText(), /blended price/)

    await prepareE2eScreenshot()
    await saveElementScreenshot('.frontier-fieldset', 'settings-usage-value-map-mtok.png')

    await taskBtn.click()
    await browser.waitUntil(
      async () => (await chart.getAttribute('data-cost-axis')) === 'perTask',
      { timeout: 5000, timeoutMsg: 'value map did not switch to $/task axis' },
    )
    assert.match(await chart.getText(), /AA cost per Intelligence Index task/)
    assert.equal(await taskBtn.getAttribute('aria-pressed'), 'true')

    await prepareE2eScreenshot()
    await saveElementScreenshot('.frontier-fieldset', 'settings-usage-value-map-task.png')
  })
})
