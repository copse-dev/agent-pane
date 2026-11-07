import { browser } from '@wdio/globals'

/** WebDriver commands that capture pixels for a screenshot. */
const CAPTURE_COMMANDS: ReadonlySet<string> = new Set(['takeScreenshot', 'takeElementScreenshot'])

const SETTLE_TIMEOUT_MS = 15_000

/**
 * Wait until the composer's context estimate is no longer pending.
 *
 * The composer footer's context wheel shows the estimate's breakdown once
 * main replies, and is `aria-busy` while one is scheduled or in flight.
 * Capturing before it lands races that reply, so a reference would show an
 * empty or a filled ring depending on timing. A capture with no composer, or
 * no estimate pending, does not wait.
 */
export async function waitForSettledContextEstimate(): Promise<void> {
  try {
    await browser.waitUntil(
      async () =>
        browser.execute(() => document.querySelector('.context-wheel[aria-busy="true"]') === null),
      { timeout: SETTLE_TIMEOUT_MS, interval: 50 },
    )
  } catch {
    // Never block a failure screenshot or a window without the composer's
    // estimate settling: report it so a racing reference can be traced here.
    console.warn(
      `[e2e] context estimate still pending after ${String(SETTLE_TIMEOUT_MS)}ms; capturing anyway`,
    )
  }
}

/** Run before every WebDriver command: settle the estimate ahead of a capture. */
export async function settleContextEstimateBeforeCapture(commandName: string): Promise<void> {
  if (CAPTURE_COMMANDS.has(commandName)) await waitForSettledContextEstimate()
}
