import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-terminal-popout-project'

async function xtermText(): Promise<string> {
  return browser.execute(() => document.querySelector('.xterm-rows')?.textContent ?? '')
}

async function approveUnsandboxedTerminalIfPrompted(): Promise<void> {
  const approval = await $('#approval-dialog')
  const unsandboxed = await approval
    .waitForDisplayed({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false)
  if (!unsandboxed) return
  await expect(approval.$('.approval-heading')).toHaveText('Open unsandboxed terminal?')
  await approval.$('.approval-approve').click()
  await approval.waitForDisplayed({ reverse: true, timeout: 10_000 })
}

describe('terminal pop-out output (#1705)', () => {
  let mainHandle: string

  before(async function () {
    this.timeout(90_000)
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
    this.timeout(120_000)

    const terminalBtn = await $('.titlebar-btn[aria-label="Open terminal"]')
    await terminalBtn.click()
    await $('#terminals-list-host').waitForDisplayed({ timeout: 10_000 })
    await approveUnsandboxedTerminalIfPrompted()
    await $('.terminal-container .xterm').waitForExist({ timeout: 30_000 })

    const popoutBtn = await $('#terminals-list-host .pane-popout-btn')
    await popoutBtn.waitForClickable({ timeout: 10_000 })
    const before = await browser.getWindowHandles()
    await popoutBtn.click()
    await browser.waitUntil(
      async () => (await browser.getWindowHandles()).length > before.length,
      { timeout: 15_000, timeoutMsg: 'expected a Terminal pop-out window' },
    )
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
    await approveUnsandboxedTerminalIfPrompted()
    await $('.terminal-container .xterm').waitForExist({ timeout: 30_000 })

    const helper = await $('.xterm-helper-textarea')
    await helper.click()
    await browser.keys(['echo', ' ', 'popout-only', '\uE007'])

    await browser.waitUntil(async () => (await xtermText()).includes('popout-only'), {
      timeout: 30_000,
      timeoutMsg: 'expected echo output in the popped-out terminal, not only in the main window',
    })

    await saveAppScreenshot('terminal-popout-output.png')
  })
})
