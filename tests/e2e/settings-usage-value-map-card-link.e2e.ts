import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { prepareE2eScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

// The value map's hover card links out to each model's vendor-published system
// card. That link has to be *reachable*, not just rendered: the card is an
// absolutely-positioned overlay that used to be `pointer-events: none`, so this
// spec checks the real hover → cross-the-gap → click path in a live renderer,
// which jsdom cannot model.
describe('settings usage value map model card link', function () {
  this.timeout(120_000)

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

    // Claude models carry a curated card entry; hover the point for one. Under
    // COPSE_MODEL_CARD_PROBE_MOCK the resolver answers without a vendor request.
    await expect(fieldset.$('circle.frontier-hit[data-model-id="claude-opus-4-8"]')).toExist()

    // Re-hover until the card opens, re-resolving the point each time.
    //
    // A single `moveTo()` is not enough here. `wireTooltip` opens the card from
    // `mouseenter` on the point, and that one event has two ways to be lost: a
    // pointer move onto an SVG child does not always deliver it, and the panel
    // re-renders when the model-card resolver lands — which replaces both the
    // point and the tooltip layer, leaving the element handle stale and the new
    // layer hidden.
    //
    // This still tests the real hover path (the product decides whether the card
    // opens); it only stops one dropped event from failing the run. The unit
    // suite already pins the handler itself: dispatching `mouseenter` on
    // `circle.frontier-hit` renders `.frontier-tooltip-content`
    // (intellect-frontier-panel.test.ts).
    const tooltip = fieldset.$('.frontier-tooltip')
    await browser.waitUntil(
      async () => {
        await fieldset.$('circle.frontier-hit[data-model-id="claude-opus-4-8"]').moveTo()
        return await tooltip.isDisplayed()
      },
      {
        timeout: 20_000,
        interval: 500,
        timeoutMsg: 'hovering the claude-opus-4-8 point never opened the value-map card',
      },
    )
    // The card section arrives with the resolver's answer, one round-trip after
    // the hover card itself opens.
    const link = tooltip.$('a.tt-card-link')
    await link.waitForDisplayed({ timeout: 5000, timeoutMsg: 'model-card link never resolved' })
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
