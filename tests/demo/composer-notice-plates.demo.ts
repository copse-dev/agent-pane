import { $, browser, expect } from '@wdio/globals'
import assert from 'node:assert/strict'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

// Composer notices take the shared flat callout plate (docs/ui-taste.md,
// "Containment is a plate"): --sev mixed at --callout-plate-fill, no rule under
// the strip, and no tinted tile behind a glyph.
async function plate(selector: string): Promise<{ image: string; rule: string; color: string }> {
  const found = await browser.execute((sel: string) => {
    const node = document.querySelector(sel)
    if (!node) return null
    const style = getComputedStyle(node)
    return {
      image: style.backgroundImage,
      rule: style.borderBottomWidth,
      color: style.backgroundColor,
    }
  }, selector)
  assert.ok(found, `${selector} renders`)
  return found
}

describe('composer notice plates', () => {
  it('draws the Guarded YOLO strip as a danger plate and the side-chat chip with the kit corner', async () => {
    await browser.url('/?scenario=thread-context')
    await $('.guarded-yolo-banner').waitForDisplayed({ timeout: 30_000 })

    const yolo = await plate('.guarded-yolo-banner')
    assert.equal(yolo.rule, '0px', 'no rule under the strip')
    assert.equal(yolo.image, 'none')
    assert.notEqual(yolo.color, 'rgba(0, 0, 0, 0)', 'the strip keeps its danger wash')
    await expect($('.msg-side-chat-chip')).toHaveStyle({ 'border-top-left-radius': '6px' })

    await saveElementScreenshot('.guarded-yolo-banner', 'guarded-yolo-plate.png')
  })

  it('draws the finished container-run banner as a success plate with a bare glyph', async () => {
    await browser.url('/?scenario=container-run')
    const banner = $('.container-run-banner')
    await banner.waitForDisplayed({ timeout: 30_000 })
    await expect(banner).toHaveAttribute('data-phase', 'finished')

    const run = await plate('.container-run-banner')
    assert.equal(run.rule, '0px', 'no rule under the banner')
    assert.notEqual(run.color, 'rgba(0, 0, 0, 0)', 'the banner keeps its wash')
    await expect($('.container-run-icon')).toHaveStyle({ 'background-color': 'rgba(0,0,0,0)' })

    await saveElementScreenshot('.container-run-banner', 'container-run-banner-plate.png')
  })
})
