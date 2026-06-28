import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')
const PROJECT_ID = 'e2e-terminal-project'

async function xtermText(): Promise<string> {
  return browser.execute(() => document.querySelector('.xterm-rows')?.textContent ?? '')
}

describe('integrated terminal', () => {
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

  it('opens a PTY shell, runs echo hello, and shows no spawn error', async function () {
    this.timeout(90_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    const terminalBtn = await $('.titlebar-btn[aria-label="Open terminal"]')
    await terminalBtn.click()

    await $('#pane-files').waitForDisplayed({ timeout: 10_000 })
    await expect(terminalBtn).toHaveElementClass('active')

    await $('.terminal-container .xterm').waitForExist({ timeout: 30_000 })

    await browser.waitUntil(
      async () => {
        const text = await xtermText()
        return (
          text.length > 0 &&
          !/posix_spawnp failed/i.test(text) &&
          !/Failed to start terminal/i.test(text)
        )
      },
      {
        timeout: 20_000,
        timeoutMsg: 'expected integrated terminal to spawn without posix_spawnp error',
      },
    )

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'terminal-shell-prompt.png'))

    const helper = await $('.xterm-helper-textarea')
    await helper.click()
    await browser.keys(['echo', ' ', 'hello', '\uE007'])

    await browser.waitUntil(async () => (await xtermText()).includes('hello'), {
      timeout: 30_000,
      timeoutMsg: 'expected echo hello output in xterm buffer',
    })

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'terminal-echo-hello.png'))
  })
})
