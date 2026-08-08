import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

// Visual eval for the close guard: quitting disposes every live agent session
// with no resume, so a close while a thread is mid-turn asks first. The test
// bridge drives the real main→renderer round trip (`test:requestCloseConfirm`)
// rather than an actual close — closing the app would end this session too.
interface CloseConfirmBridge {
  requestCloseConfirm: () => Promise<boolean>
}

/** Long enough that the thread stays `running` across all three cases. */
const RUN_HOLD_MS = 90_000

async function requestClose(): Promise<void> {
  await browser.execute(() => {
    const bridge = (window as unknown as { __copseE2e?: CloseConfirmBridge }).__copseE2e
    if (!bridge?.requestCloseConfirm) throw new Error('__copseE2e.requestCloseConfirm unavailable')
    const host = window as unknown as { __closeConfirmAnswers?: boolean[] }
    host.__closeConfirmAnswers ??= []
    const answers = host.__closeConfirmAnswers
    void bridge.requestCloseConfirm().then((confirmed) => answers.push(confirmed))
  })
}

async function closeAnswers(): Promise<boolean[]> {
  return await browser.execute(
    () => (window as unknown as { __closeConfirmAnswers?: boolean[] }).__closeConfirmAnswers ?? [],
  )
}

/**
 * Displayed, not merely present. `input-bar.ts` creates the stop button once at
 * mount with `hidden` and toggles `stopBtn.hidden = !running`, so it is in the
 * DOM from app start and `$$('.stop-btn').length > 0` is true before any turn
 * has begun.
 *
 * That made `ensureRunning()` return immediately without ever submitting a
 * prompt, so no thread was ever `running`, `confirmClose()` correctly declined
 * to prompt, and the two guarded cases below failed waiting 30s for a dialog
 * that was right not to appear.
 */
async function isRunning(): Promise<boolean> {
  return await $('.stop-btn').isDisplayed()
}

/** Hold a turn open so the thread reports `status === 'running'`. */
async function ensureRunning(): Promise<void> {
  if (await isRunning()) return
  await setComposerValue(`Summarise this repo. [[mock:delay_ms ${String(RUN_HOLD_MS)}]]`)
  await $('.submit-btn').click()
  await browser.waitUntil(isRunning, {
    timeout: 30_000,
    timeoutMsg: 'expected the run to start',
  })
}

async function waitForAnswers(count: number): Promise<void> {
  await browser.waitUntil(async () => (await closeAnswers()).length === count, {
    timeout: 15_000,
    timeoutMsg: `expected ${String(count)} close answer(s) to reach main`,
  })
}

describe('close confirmation while a thread is working', function () {
  this.timeout(180_000)

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-close-confirm-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
      windowBounds: { width: 1280, height: 800 },
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('closes without a prompt when no thread is working', async () => {
    await requestClose()
    await waitForAnswers(1)
    expect(await closeAnswers()).toEqual([true])
    await expect($('#confirm-dialog')).not.toBeDisplayed()
  })

  it('warns mid-turn and keeps the app up when the user backs out', async () => {
    await ensureRunning()
    await requestClose()

    const dialog = await $('#confirm-dialog')
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await expect(dialog.$('.confirm-dialog-message')).toHaveText(
      'Close Copse while the agent is still working?',
    )
    const detail = await dialog.$('.confirm-dialog-detail').getText()
    expect(detail).toContain('mid-turn')
    expect(detail).toContain('anything the agent has not already written to your files is lost')
    await expect(dialog.$('.confirm-dialog-confirm')).toHaveText('Close anyway')
    await expect(dialog.$('.confirm-dialog-cancel')).toHaveText('Keep working')

    await saveElementScreenshot('#confirm-dialog', 'close-confirm-working-thread.png')

    await dialog.$('.confirm-dialog-cancel').click()
    await waitForAnswers(2)
    expect(await closeAnswers()).toEqual([true, false])
    // Backing out leaves the run untouched.
    expect(await isRunning()).toBe(true)
  })

  it('closes anyway when the user confirms', async () => {
    await ensureRunning()
    await requestClose()

    const dialog = await $('#confirm-dialog')
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await dialog.$('.confirm-dialog-confirm').click()

    await waitForAnswers(3)
    expect(await closeAnswers()).toEqual([true, false, true])
  })
})
