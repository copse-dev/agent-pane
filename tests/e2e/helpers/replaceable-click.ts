import { $ } from '@wdio/globals'

/**
 * True when WebDriver reports that the element it was about to act on has
 * left the document: `stale element reference: stale element not found in the
 * current frame`.
 */
function isStaleElementError(error: unknown): boolean {
  return error instanceof Error && /stale element/i.test(error.message)
}

/**
 * Click the element `selector` matches in a view that redraws itself.
 *
 * Some views rebuild their DOM wholesale on any store change. The sidebar's
 * `render()` (`src/renderer/views/projects-pane.ts`) clears and rebuilds every
 * project and thread row whenever a thread's status, branch, title or PR data
 * changes. A WebDriver click is a lookup followed by a separate click request,
 * so a redraw that lands between the two leaves the click aimed at a removed
 * node. A person's click cannot fall between those steps; it hits whichever
 * row is under the pointer.
 *
 * Each attempt resolves `selector` afresh and performs a real WebDriver click,
 * so interactability checks still apply. Only the stale-node race is retried.
 * Any other failure (missing element, intercepted click) fails at once, and a
 * row that keeps going stale for the whole timeout fails with `timeoutMsg`.
 */
export async function clickReplaceable(
  selector: string,
  timeoutMsg: string,
  timeout = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeout
  for (;;) {
    try {
      await $(selector).click()
      return
    } catch (error) {
      if (!isStaleElementError(error)) throw error
      if (Date.now() >= deadline) throw new Error(timeoutMsg, { cause: error })
    }
  }
}
