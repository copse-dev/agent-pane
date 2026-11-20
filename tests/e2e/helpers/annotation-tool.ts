import { $, expect } from '@wdio/globals'

/**
 * Choose an annotation shape inside `scope` the way a user does. In a roomy
 * host each shape has its own button on the tool strip. In a narrow pane the
 * four share one button: the first press takes the last shape used, a second
 * opens the rest (src/renderer/drawing/annotation-layer.ts, STRIP_LAYOUTS).
 *
 * `layout` is the one the spec's pane is expected to get, and it is asserted
 * before anything is pressed. Taking whichever route happened to be on screen
 * would let a pane that stopped fitting its strip pass unnoticed.
 */
export async function selectAnnotationShape(
  scope: string,
  shape: 'line' | 'arrow' | 'rect' | 'ellipse',
  layout: 'each' | 'folded',
): Promise<void> {
  await expect($(`${scope} .annotation-toolstrip`)).toHaveAttribute('data-shapes', layout)
  if (layout === 'each') {
    await $(`${scope} .annotation-toolstrip [data-tool="${shape}"]`).click()
    return
  }
  const fold = $(`${scope} .annotation-shape-fold`)
  if ((await fold.getAttribute('aria-pressed')) !== 'true') await fold.click()
  await fold.click()
  await $(`${scope} .annotation-popover [data-tool="${shape}"]`).click()
}
