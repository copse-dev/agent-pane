// The discovered-port list is the one rounded card in the app that also carries a
// selection marker, so it is where an accent rail is most tempting — and a rail is
// clipped to the border-radius, so it would bow around the card's corners. See
// `docs/ui-taste.md` → "Accent rails never curve". `accent-rails.test.ts` pins the
// stylesheet; this asserts the rendered result, where the radius and the shadow
// have actually been resolved and composited.
import assert from 'node:assert/strict'
import { $, $$, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

/** Ports the `vnc-discovered-ports` scenario answers `vnc:discover` with. */
const PORTS = [5900, 5901, 5902]

describe('remote desktop discovered ports', () => {
  before(async () => {
    await browser.url('/?scenario=vnc-discovered-ports')
    const control = $('[data-panel-control="vnc"]')
    await control.waitForDisplayed({ timeout: 20_000 })
    await control.click()
    // Opening the pane scans the selected machine on its own; the retry button
    // ("Try again") only appears when that scan comes back empty.
    await $('.vnc-discovered-port.selected').waitForDisplayed({ timeout: 20_000 })
  })

  it('lists every discovered port and selects the first', async () => {
    assert.deepEqual(
      await $$('.vnc-discovered-port').map((port) => port.getAttribute('data-port')),
      PORTS.map(String),
    )
    await expect($('.vnc-discovered-port.selected')).toHaveAttribute('data-port', String(PORTS[0]))
    // The list is a discovery affordance, so the choice has to reach the field
    // the connect button actually reads.
    await expect($('.vnc-port-input')).toHaveValue(String(PORTS[0]))
  })

  it('marks the selected port with a ring, not a rail that curves', async () => {
    const marker = await browser.execute(() => {
      const element = document.querySelector<HTMLElement>('.vnc-discovered-port.selected')
      if (!element) return null
      const style = getComputedStyle(element)
      return {
        boxShadow: style.boxShadow,
        // Computed `border-radius` resolves to per-corner longhands.
        startCorners: [style.borderTopLeftRadius, style.borderBottomLeftRadius],
        endCorners: [style.borderTopRightRadius, style.borderBottomRightRadius],
        borderLeftWidth: style.borderLeftWidth,
        borderRightWidth: style.borderRightWidth,
        borderTopWidth: style.borderTopWidth,
      }
    })
    assert.ok(marker, 'a discovered port must be selected on arrival')

    // The card stays rounded — squaring it would be the other way to satisfy the
    // rule, so pin which resolution this surface chose.
    for (const radius of [...marker.startCorners, ...marker.endCorners]) {
      assert.notEqual(radius, '0px', `selected port must stay rounded, got ${radius}`)
    }
    // A ring is offset 0 0 with a spread; a rail carries a horizontal offset and
    // would be clipped into a curve by those corners.
    const offsets = marker.boxShadow.match(/(-?[\d.]+)px\s+(-?[\d.]+)px/)
    assert.ok(offsets, `selected port must paint a shadow, got ${marker.boxShadow}`)
    assert.equal(Number(offsets[1]), 0, `shadow must not be offset sideways: ${marker.boxShadow}`)
    assert.equal(Number(offsets[2]), 0, `shadow must not be offset vertically: ${marker.boxShadow}`)
    assert.match(marker.boxShadow, /inset/, 'the ring must be inset so it hugs the card edge')
    // A one-sided border is the other way to draw a rail. The card's border is
    // even on every side, which a radius bends uniformly rather than into a bar.
    assert.equal(marker.borderLeftWidth, marker.borderRightWidth)
    assert.equal(marker.borderLeftWidth, marker.borderTopWidth)

    await saveElementScreenshot('.vnc-discovered-ports', 'vnc-discovered-ports.png')
  })
})
