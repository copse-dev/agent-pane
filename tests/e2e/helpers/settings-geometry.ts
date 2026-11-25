import assert from 'node:assert/strict'
import { browser } from '@wdio/globals'

interface CardLegendBox {
  found: boolean
  visible: boolean
  hasFill: boolean
  legendTop: number
  legendLeft: number
  legendBottom: number
  /** Top of the first rendered child after the legend, or null when there is none. */
  nextTop: number | null
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
        legendBottom: 0,
        nextTop: null,
        contentTop: 0,
        contentLeft: 0,
      }
    }
    const style = getComputedStyle(card)
    const cardRect = card.getBoundingClientRect()
    const legendRect = legend.getBoundingClientRect()
    let next = legend.nextElementSibling
    while (next && next.getClientRects().length === 0) next = next.nextElementSibling
    return {
      found: true,
      visible: legendRect.height > 0,
      hasFill:
        style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent',
      legendTop: legendRect.top,
      legendLeft: legendRect.left,
      legendBottom: legendRect.bottom,
      nextTop: next ? next.getBoundingClientRect().top : null,
      contentTop: cardRect.top + Number.parseFloat(style.paddingTop),
      contentLeft: cardRect.left + Number.parseFloat(style.paddingLeft),
    }
  }, legendText)
}

/**
 * Assert a nested card's title sits inside the card, within its padding, and the
 * card's content starts below it rather than under the floated title.
 */
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
  if (box.nextTop !== null) {
    assert.ok(
      box.nextTop >= box.legendBottom - 0.5,
      `"${legendText}" content top ${String(box.nextTop)} must start below its legend (${String(box.legendBottom)})`,
    )
  }
}
