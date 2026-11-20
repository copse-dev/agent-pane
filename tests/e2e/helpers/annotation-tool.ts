import { $ } from '@wdio/globals'

/**
 * Choose an annotation shape inside `scope` the way a user does. In a roomy
 * host each shape has its own button on the tool strip. In a narrow pane the
 * four share one button: the first press takes the last shape used, a second
 * opens the rest (src/renderer/drawing/annotation-layer.ts, STRIP_LAYOUTS).
 * Which layout a host gets follows its width, so a spec asks for the shape and
 * this takes whichever route is on screen.
 */
export async function selectAnnotationShape(
  scope: string,
  shape: 'line' | 'arrow' | 'rect' | 'ellipse',
): Promise<void> {
  const own = $(`${scope} .annotation-toolstrip [data-tool="${shape}"]`)
  if (await own.isDisplayed()) {
    await own.click()
    return
  }
  const fold = $(`${scope} .annotation-shape-fold`)
  if ((await fold.getAttribute('aria-pressed')) !== 'true') await fold.click()
  await fold.click()
  await $(`${scope} .annotation-popover [data-tool="${shape}"]`).click()
}
