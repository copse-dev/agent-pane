import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')
const PROJECT_ID = 'e2e-terminal-new-thread-project'

async function xtermText(): Promise<string> {
  return browser.execute(() => document.querySelector('.xterm-rows')?.textContent ?? '')
}

async function approveUnsandboxedTerminalIfShown(): Promise<void> {
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

describe('terminal after new thread', () => {
  before(async function () {
    this.timeout(90_000)
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID)
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('spawns a shell for a brand-new thread without an ownership race', async function () {
    this.timeout(90_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    const terminalBtn = await $('.titlebar-btn[aria-label="Open terminal"]')
    await terminalBtn.click()
    await $('#pane-files').waitForDisplayed({ timeout: 10_000 })
    await $('.terminal-container .xterm').waitForExist({ timeout: 30_000 })
    await approveUnsandboxedTerminalIfShown()

    await browser.waitUntil(
      async () => {
        const text = await xtermText()
        return text.length > 0 && !/Failed to start terminal/i.test(text)
      },
      {
        timeout: 20_000,
        timeoutMsg: 'expected initial terminal to spawn before opening a new thread',
      },
    )

    await $('.project-new-thread-btn').click()
    await expect($('.chat-row.selected .chat-title')).toHaveText('New Thread')

    await browser.waitUntil(
      async () => {
        const text = await xtermText()
        return (
          text.length > 0 &&
          !/Failed to start terminal/i.test(text) &&
          !/does not belong to project/i.test(text) &&
          !/is not persisted yet/i.test(text)
        )
      },
      {
        timeout: 20_000,
        timeoutMsg:
          'expected new-thread terminal spawn to wait for threads:create (no ownership error)',
      },
    )

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'terminal-new-thread-spawn.png'))
  })
})
