import assert from 'node:assert/strict'
import { browser } from '@wdio/globals'

interface CheckboxRowGeometry {
  boxRight: number
  boxCenterY: number
  textLeft: number
  textTop: number
  textBottom: number
  text: string
}

/**
 * Assert a `<label>` wrapping a checkbox lays the box inline beside its wording.
 *
 * forms.css makes every `<label>` a column flex container, so a checkbox label
 * that a later rule forgets to turn back into a row stacks the box centred above
 * its text. Measured on the rendered text itself (a Range over the label's own
 * text nodes), not the label box, so padding or a hover fill cannot hide it: the
 * box must sit to the left of the first line of text and its vertical centre
 * must fall inside that line.
 */
export async function assertCheckboxBesideLabel(labelSelector: string): Promise<void> {
  const geometry = await browser.execute((selector): CheckboxRowGeometry | string => {
    const label = document.querySelector<HTMLLabelElement>(selector)
    if (!label) return `no label matches ${selector}`
    const box = label.querySelector<HTMLInputElement>('input[type="checkbox"]')
    if (!box) return `${selector} holds no checkbox`
    const textNodes = Array.from(label.childNodes).filter(
      (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
    )
    const first = textNodes[0]
    const last = textNodes.at(-1)
    if (!first || !last) return `${selector} has no text of its own`
    const range = document.createRange()
    range.setStartBefore(first)
    range.setEndAfter(last)
    const line = range.getClientRects()[0]
    if (!line) return `${selector} text is not rendered`
    const boxRect = box.getBoundingClientRect()
    return {
      boxRight: boxRect.right,
      boxCenterY: boxRect.top + boxRect.height / 2,
      textLeft: line.left,
      textTop: line.top,
      textBottom: line.bottom,
      text: textNodes.map((node) => (node.textContent ?? '').trim()).join(' '),
    }
  }, labelSelector)
  if (typeof geometry === 'string') assert.fail(geometry)
  const detail = JSON.stringify(geometry)
  assert.ok(
    geometry.boxRight <= geometry.textLeft,
    `checkbox must sit left of "${geometry.text}", not above it: ${detail}`,
  )
  assert.ok(
    geometry.boxCenterY >= geometry.textTop && geometry.boxCenterY <= geometry.textBottom,
    `checkbox must share a line with "${geometry.text}": ${detail}`,
  )
}
