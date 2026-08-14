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

    // The empty profile has no routable cloud provider, so expose the catalog
    // overlay before choosing a curated Claude model. Under
    // COPSE_MODEL_CARD_PROBE_MOCK the card resolver answers without a vendor request.
    const discover = fieldset.$('button.frontier-discover')
    await discover.waitForClickable({ timeout: 20_000 })
    await discover.click()
    await expect(discover).toHaveAttribute('aria-pressed', 'true')
    const modelPoint = fieldset.$('circle.frontier-hit[data-model-id="claude-opus-4-8"]')
    await modelPoint.waitForExist({
      timeout: 20_000,
      timeoutMsg: 'the mocked Claude model never appeared in the value map',
    })

    // Existing is not enough to hover. The chart sits far enough down the usage
    // section that the point can be outside the viewport, and a pointer move to
    // an element origin that is out of view is a WebDriver *error* ("move target
    // out of bounds"), not a move that quietly misses. Scroll it into the middle
    // of the viewport first, via the element's own `scrollIntoView` so the
    // settings dialog's scroll container is the one that moves.
    await browser.execute(() => {
      document
        .querySelector('circle.frontier-hit[data-model-id="claude-opus-4-8"]')
        ?.scrollIntoView({ block: 'center', inline: 'center' })
    })

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
    //
    // `moveTo` throwing has to be carried out to the timeout message. A bare
    // `await` inside the condition makes every failed move look identical to a
    // move that landed on a card that did not open, which is how a positioning
    // error reads as "never opened" and costs a run to diagnose.
    // The message is built at throw time, not passed as `timeoutMsg`: waitUntil
    // destructures its options once, up front, so anything derived from the loop
    // has to be assembled after the loop has actually run.
    const tooltip = fieldset.$('.frontier-tooltip')
    let lastMoveError = ''
    try {
      await browser.waitUntil(
        async () => {
          try {
            await fieldset.$('circle.frontier-hit[data-model-id="claude-opus-4-8"]').moveTo()
          } catch (err) {
            lastMoveError = err instanceof Error ? err.message : String(err)
            return false
          }
          lastMoveError = ''
          return await tooltip.isDisplayed()
        },
        { timeout: 20_000, interval: 500 },
      )
    } catch {
      throw new Error(
        'hovering the claude-opus-4-8 point never opened the value-map card — ' +
          (lastMoveError
            ? `the last pointer move failed: ${lastMoveError}`
            : 'every pointer move landed but the card stayed hidden'),
      )
    }
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
