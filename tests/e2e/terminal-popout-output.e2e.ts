import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-terminal-popout-project'

async function xtermText(): Promise<string> {
  return browser.execute(() => document.querySelector('.xterm-rows')?.textContent ?? '')
}

async function approvalDialogOpen(): Promise<boolean> {
  return browser.execute(() => {
    const dialog = document.getElementById('approval-dialog')
    return dialog instanceof HTMLDialogElement && dialog.open
  })
}

async function approveUnsandboxedTerminalIfPrompted(timeoutMs = 5_000): Promise<boolean> {
  const approval = await $('#approval-dialog')
  const unsandboxed =
    timeoutMs <= 0
      ? await approvalDialogOpen()
      : await approval
          .waitForDisplayed({ timeout: timeoutMs })
          .then(() => true)
          .catch(() => false)
  if (!unsandboxed) return false
  await expect(approval.$('.approval-heading')).toHaveText('Open unsandboxed terminal?')
  await approval.$('.approval-approve').click()
  await approval.waitForDisplayed({ reverse: true, timeout: 10_000 })
  return true
}

/**
 * A pop-out is a new renderer, so it opens its own PTY. On hosts without a
 * project sandbox that create still needs "Open unsandboxed terminal?" — which
 * now lands on the pop-out, but used to appear on the (hidden) main window.
 * Poll both until the shell has actually spawned.
 */
async function waitForPopoutShell(mainHandle: string, popoutHandle: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      await browser.switchToWindow(popoutHandle)
      const text = await xtermText()
      if (/Failed to start terminal/i.test(text)) {
        throw new Error(`pop-out terminal failed to start: ${text}`)
      }
      if (text.trim().length > 0 && !/Open a folder/i.test(text)) return true

      if (await approveUnsandboxedTerminalIfPrompted(0)) return false

      await browser.switchToWindow(mainHandle)
      await approveUnsandboxedTerminalIfPrompted(0)
      return false
    },
    {
      timeout: 25_000,
      timeoutMsg: 'expected the popped-out terminal PTY to spawn',
    },
  )
  await browser.switchToWindow(popoutHandle)
}

describe('terminal pop-out output (#1705)', function () {
  this.timeout(90_000)

  let mainHandle: string

  before(async function () {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID)
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
    mainHandle = (await browser.getWindowHandles())[0]
  })

  after(async () => {
    try {
      await browser.switchToWindow(mainHandle)
    } catch {
      // session already gone
    }
    resetUserData()
  })

  it('shows shell output in the popped-out Terminal window', async function () {
    const terminalBtn = await $('.titlebar-btn[aria-label="Open terminal"]')
    await terminalBtn.click()
    await $('#terminals-list-host').waitForDisplayed({ timeout: 10_000 })
    await approveUnsandboxedTerminalIfPrompted()
    await $('.terminal-container .xterm').waitForExist({ timeout: 20_000 })
    await browser.waitUntil(
      async () => {
        const text = await xtermText()
        return text.trim().length > 0 && !/Failed to start terminal/i.test(text)
      },
      { timeout: 20_000, timeoutMsg: 'expected the docked terminal PTY to spawn' },
    )

    const popoutBtn = await $('#terminals-list-host .pane-popout-btn')
    await popoutBtn.waitForClickable({ timeout: 10_000 })
    const before = await browser.getWindowHandles()
    await popoutBtn.click()
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length > before.length, {
      timeout: 15_000,
      timeoutMsg: 'expected a Terminal pop-out window',
    })
    const popoutHandle = (await browser.getWindowHandles()).find((h) => !before.includes(h))
    if (!popoutHandle) throw new Error('expected a Terminal pop-out window handle')

    await browser.switchToWindow(popoutHandle)
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => document.documentElement.getAttribute('data-popout-mode') === 'terminal',
        )) === true,
      { timeout: 20_000, timeoutMsg: 'pop-out window did not boot in terminal mode' },
    )
    await $('.terminal-container .xterm').waitForExist({ timeout: 20_000 })
    await waitForPopoutShell(mainHandle, popoutHandle)

    const helper = await $('.xterm-helper-textarea')
    await helper.click()
    await browser.keys(['echo', ' ', 'popout-only', '\uE007'])

    await browser.waitUntil(async () => (await xtermText()).includes('popout-only'), {
      timeout: 20_000,
      timeoutMsg: 'expected echo output in the popped-out terminal, not only in the main window',
    })

    await saveAppScreenshot('terminal-popout-output.png')
  })
})
