import { browser } from '@wdio/globals'

/** WebDriver commands that capture pixels for a screenshot. */
const CAPTURE_COMMANDS = ['takeScreenshot', 'takeElementScreenshot'] as const

const SETTLE_TIMEOUT_MS = 10_000

/** Set while a failure dump captures: it must never wait on, or fail for, the app. */
let settleSkipped = false

/**
 * Wait until the composer's context estimate is no longer pending.
 *
 * The composer footer's context wheel shows the estimate's breakdown once
 * main replies, and is `aria-busy` while one is scheduled or in flight.
 * Capturing before it lands races that reply, so a reference would show an
 * empty or a filled ring depending on timing. A capture with no composer, or
 * no estimate pending, does not wait. One still pending after the timeout
 * fails the capture rather than recording a pending state.
 */
export async function waitForSettledContextEstimate(): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(() => document.querySelector('.context-wheel[aria-busy="true"]') === null),
    {
      timeout: SETTLE_TIMEOUT_MS,
      interval: 50,
      timeoutMsg: `The composer's context estimate was still pending after ${String(SETTLE_TIMEOUT_MS)}ms (.context-wheel[aria-busy="true"]); refusing to capture a pending context wheel`,
    },
  )
}

/** The slice of a WebDriver session this helper patches. */
export interface CaptureSession {
  /**
   * WDIO's supported command override. Assigning through the `@wdio/globals`
   * Proxy would not reach the real browser (see `after-test-safety.ts`), and a
   * `beforeCommand` hook only logs what it throws, so a capture that must fail
   * on an unsettled estimate wraps the command itself.
   */
  overwriteCommand?: (
    name: (typeof CAPTURE_COMMANDS)[number],
    fn: (
      this: unknown,
      origCommand: (...args: unknown[]) => Promise<unknown>,
      ...args: unknown[]
    ) => Promise<unknown>,
  ) => void
}

const capturePatched = new WeakSet<object>()

/**
 * Make every screenshot command wait for the composer's context estimate, so
 * the footer's context wheel never races main's reply. Installed from
 * `wdio.conf.ts`'s `before()`.
 */
export function installCaptureSettle(
  session: CaptureSession,
  settle: () => Promise<void> = waitForSettledContextEstimate,
): void {
  if (typeof session.overwriteCommand !== 'function') return
  if (capturePatched.has(session)) return
  capturePatched.add(session)
  for (const name of CAPTURE_COMMANDS) {
    session.overwriteCommand(name, async function settleThenCapture(origCommand, ...args) {
      if (!settleSkipped) await settle()
      return origCommand.apply(this, args)
    })
  }
}

/** Capture a debugging screenshot as-is, without waiting for the estimate. */
export async function withoutCaptureSettle<T>(capture: () => Promise<T>): Promise<T> {
  settleSkipped = true
  try {
    return await capture()
  } finally {
    settleSkipped = false
  }
}
