import { $, browser } from '@wdio/globals'
import assert from 'node:assert/strict'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

// Expanded reasoning sits on one plain raised plate (docs/ui-taste.md,
// "Containment is a plate"): a fill, with no sheen, glow, hatch, outline or
// inset highlight on top of it.
describe('an open thinking block', () => {
  it('is one flat raised plate', async () => {
    await browser.url('/?scenario=concise-thread-disabled')
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    // Open the tool rollup, then the reasoning inside it, as a user would.
    await $('.tool-card-rollup > summary').click()
    await $('.message-reasoning > summary').waitForDisplayed()
    await $('.message-reasoning > summary').click()
    await $('.message-reasoning[open]').waitForDisplayed()

    const plate = await browser.execute(() => {
      const reasoning = document.querySelector('.message-reasoning[open]')
      if (!reasoning) return null
      const style = getComputedStyle(reasoning)
      return {
        image: style.backgroundImage,
        color: style.backgroundColor,
        border: style.borderTopWidth,
        shadow: style.boxShadow,
      }
    })
    assert.ok(plate, 'the reasoning disclosure opened')
    assert.equal(plate.image, 'none', 'no gradient or hatch')
    assert.notEqual(plate.color, 'rgba(0, 0, 0, 0)', 'the plate has a fill')
    assert.equal(plate.border, '0px', 'no outline')
    assert.equal(plate.shadow, 'none', 'no inset highlight')

    await saveElementScreenshot('.message-reasoning[open]', 'reasoning-raised-plate.png')
  })
})
