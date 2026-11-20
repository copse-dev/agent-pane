import assert from 'node:assert/strict'
import { browser } from '@wdio/globals'

interface CardLegendBox {
  found: boolean
  visible: boolean
  hasFill: boolean
  legendTop: number
  legendLeft: number
  contentTop: number
  contentLeft: number
}

/**
 * Where a card's `<legend>` sits relative to its card's padding box. A rendered
 * legend lives in the fieldset's border area, so on a borderless filled card it
 * straddles the card's top edge; a card title belongs inside the padding.
 */
async function cardLegendBox(legendText: string): Promise<CardLegendBox> {
  return browser.execute((text) => {
    const legend = Array.from(
      document.querySelectorAll<HTMLElement>('#settings-dialog fieldset > legend'),
    ).find((node) => node.textContent.trim() === text)
    const card = legend?.parentElement
    if (!legend || !card) {
      return {
        found: false,
        visible: false,
        hasFill: false,
        legendTop: 0,
        legendLeft: 0,
        contentTop: 0,
        contentLeft: 0,
      }
    }
    const style = getComputedStyle(card)
    const cardRect = card.getBoundingClientRect()
    const legendRect = legend.getBoundingClientRect()
    return {
      found: true,
      visible: legendRect.height > 0,
      hasFill:
        style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent',
      legendTop: legendRect.top,
      legendLeft: legendRect.left,
      contentTop: cardRect.top + Number.parseFloat(style.paddingTop),
      contentLeft: cardRect.left + Number.parseFloat(style.paddingLeft),
    }
  }, legendText)
}

/** Assert a nested card's title sits inside the card, within its padding. */
export async function assertLegendInsideCard(legendText: string): Promise<void> {
  const box = await cardLegendBox(legendText)
  assert.ok(box.found, `legend "${legendText}" must render`)
  assert.ok(box.visible, `legend "${legendText}" must be visible`)
  assert.ok(box.hasFill, `"${legendText}" must be a filled card`)
  assert.ok(
    box.legendTop >= box.contentTop - 0.5,
    `"${legendText}" legend top ${String(box.legendTop)} must sit inside the card padding (${String(box.contentTop)})`,
  )
  assert.ok(
    box.legendLeft >= box.contentLeft - 0.5,
    `"${legendText}" legend left ${String(box.legendLeft)} must sit inside the card padding (${String(box.contentLeft)})`,
  )
}

interface SettingsViewportBox {
  top: number
  bottom: number
  height: number
  visibleTop: number
  visibleBottom: number
  topmost: boolean
}

/**
 * Assert `selector` is somewhere a user looking at Settings can read it: inside
 * the `.settings-content` scrollport, above the sticky Save/Cancel bar and its
 * frosted fade, and not covered by anything else. `toBeDisplayed` passes for a
 * line that rendered below the fold, so it cannot prove an outcome was seen.
 */
export async function assertVisibleInSettings(selector: string): Promise<void> {
  const box = await browser.execute((sel): SettingsViewportBox | null => {
    const target = document.querySelector(sel)
    const scroller = target?.closest('.settings-content')
    if (!target || !scroller) return null
    const rect = target.getBoundingClientRect()
    const viewport = scroller.getBoundingClientRect()
    const bar = scroller.querySelector(':scope > .settings-buttons')
    let visibleBottom = viewport.bottom
    if (bar) {
      const barRect = bar.getBoundingClientRect()
      // The bar's fade starts its margin-top above the bar (settings.css).
      const fade = Number.parseFloat(getComputedStyle(bar).marginTop) || 0
      if (barRect.height > 0) visibleBottom = Math.min(visibleBottom, barRect.top - fade)
    }
    const probe = document.elementFromPoint(
      rect.left + Math.min(rect.width / 2, 24),
      rect.top + rect.height / 2,
    )
    return {
      top: rect.top,
      bottom: rect.bottom,
      height: rect.height,
      visibleTop: viewport.top,
      visibleBottom,
      topmost: probe !== null && target.contains(probe),
    }
  }, selector)
  assert.ok(box, `${selector} must render inside the Settings scrollport`)
  const where = JSON.stringify(box)
  assert.ok(box.height > 0, `${selector} must have a box: ${where}`)
  assert.ok(
    box.top >= box.visibleTop - 0.5 && box.bottom <= box.visibleBottom + 0.5,
    `${selector} must sit in the visible part of the Settings scrollport: ${where}`,
  )
  assert.ok(box.topmost, `${selector} must not be covered at its own centre: ${where}`)
}
