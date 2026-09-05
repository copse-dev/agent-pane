import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { approveUnsandboxedTerminalIfPrompted } from './helpers/terminal-approval.ts'

describe('terminal read screening coverage', function () {
  this.timeout(90_000)

  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-terminal-read-coverage', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => resetUserData())

  it('asks before sharing oversized output without claiming it was screened', async () => {
    await $('.titlebar-btn[aria-label="Open terminal"]').click()
    await approveUnsandboxedTerminalIfPrompted()
    await $('.terminal-container .xterm').waitForExist({ timeout: 30_000 })
    await browser.waitUntil(
      () =>
        browser.execute(
          () => (document.querySelector('.xterm-rows')?.textContent?.length ?? 0) > 0,
        ),
      { timeout: 20_000 },
    )
    await $('.xterm-helper-textarea').click()
    // Synthetic, non-sensitive output larger than the classifier's 6K window.
    await browser.keys(["printf '%080d\\n' {1..100}; printf 'TERMINAL_READ_READY\\n'", '\uE007'])
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document.querySelector('.xterm-rows')?.textContent?.includes('TERMINAL_READ_READY') ??
            false,
        ),
      { timeout: 20_000 },
    )
    await setComposerValue('[[mcp:read_terminal {"action":"read","max_lines":2000}]]')
    await $('.submit-btn').click()
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Share terminal output with the agent?')
    await expect(dialog).toHaveText(expect.stringContaining('snapshot was not screened'))
    await expect(dialog).not.toHaveText(expect.stringContaining('were fully screened'))
    await saveElementScreenshot('#approval-dialog', 'terminal-read-coverage-approval.png')
    await dialog.$('.approval-reject').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
  })
})
