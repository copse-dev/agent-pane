import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

// Pop-out windows must never show onboarding, even when the completed flag is
// off: the flag is flipped false live (so the value the pop-out's boot reads is
// stale-proof) before detaching a pane. Also proves the main window doesn't
// spawn onboarding mid-session — the gate runs at boot only.
describe('onboarding: pop-out windows are exempt', () => {
  let mainHandle: string

  before(async function () {
    this.timeout(120_000)
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-onboarding-popout')
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
    mainHandle = (await browser.getWindowHandles())[0]
  })

  after(async () => {
    try {
      await browser.switchToWindow(mainHandle)
    } catch {
      // session already gone — nothing to do
    }
    resetUserData()
  })

  it('a pop-out booted on an incomplete profile shows no onboarding', async function () {
    this.timeout(120_000)
    await browser.execute(() => window.api.settings.set('onboardingCompleted', false))

    const before = await browser.getWindowHandles()
    await browser.execute(() => window.api.panes.popout('explorer'))
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length > before.length, {
      timeout: 20_000,
      timeoutMsg: 'expected a pop-out window',
    })
    const popoutHandle = (await browser.getWindowHandles()).find((h) => !before.includes(h))
    expect(popoutHandle).toBeDefined()

    await browser.switchToWindow(popoutHandle as string)
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => document.documentElement.getAttribute('data-popout-mode') === 'explorer',
        ),
      { timeout: 30_000, timeoutMsg: 'pop-out window did not boot' },
    )
    // The pop-out completed its boot (including the onboarding gate) with the
    // flag false, and still must not show the dialog.
    expect(
      await browser.execute(
        () => document.querySelector<HTMLDialogElement>('#onboarding-dialog')?.open ?? false,
      ),
    ).toBe(false)

    // The main window booted on a completed profile; flipping the flag
    // mid-session must not conjure the dialog there either.
    await browser.switchToWindow(mainHandle)
    expect(
      await browser.execute(
        () => document.querySelector<HTMLDialogElement>('#onboarding-dialog')?.open ?? false,
      ),
    ).toBe(false)
  })
})
