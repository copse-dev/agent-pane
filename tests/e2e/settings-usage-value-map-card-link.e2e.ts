import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { prepareE2eScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

// The value map's hover card links out to each model's vendor-published system
// card. That link has to be *reachable*, not just rendered: the card is an
// absolutely-positioned overlay that used to be `pointer-events: none`, so this
// spec checks the real hover → cross-the-gap → click path in a live renderer,
// which jsdom cannot model.
describe('settings usage value map model card link', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-value-map-card')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('opens a hover card with a link to the model card and keeps it reachable', async () => {
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="usage"]').click()
    const fieldset = $('.frontier-fieldset')
    await expect(fieldset).toBeDisplayed()

    // Claude models carry a curated card entry; hover the point for one.
    const point = fieldset.$('circle.frontier-hit[data-model-id="claude-opus-4-8"]')
    await expect(point).toExist()
    await point.moveTo()

    const tooltip = fieldset.$('.frontier-tooltip')
    await expect(tooltip).toBeDisplayed()
    const link = tooltip.$('a.tt-card-link')
    await expect(link).toBeDisplayed()
    assert.match(await link.getAttribute('href'), /^https:\/\//)
    // Opened by the shell, not navigated in-renderer.
    assert.equal(await link.getAttribute('target'), '_blank')

    await prepareE2eScreenshot()
    await saveElementScreenshot('.frontier-fieldset', 'settings-usage-value-map-card-link.png')

    // The pointer has to be able to leave the point, cross the gap, and land on
    // the link without the card vanishing underneath it.
    await link.moveTo()
    await browser.pause(400)
    await expect(tooltip).toBeDisplayed()
    await expect(link).toBeDisplayed()
  })
})
