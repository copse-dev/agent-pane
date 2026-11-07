import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

async function terminalText(): Promise<string> {
  return browser.execute(() => document.querySelector('.xterm-rows')?.textContent ?? '')
}

async function transferText(kind: 'paste' | 'drop', text: string): Promise<void> {
  await browser.execute(
    (eventKind, value) => {
      const target = document.querySelector('.terminal-container .xterm-helper-textarea')
      if (!target) throw new Error('Terminal input missing')
      const transfer = new DataTransfer()
      transfer.setData('text/plain', value)
      target.dispatchEvent(
        eventKind === 'paste'
          ? new ClipboardEvent('paste', {
              bubbles: true,
              cancelable: true,
              clipboardData: transfer,
            })
          : new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      )
    },
    kind,
    text,
  )
}

describe('terminal paste protection', () => {
  before(async function () {
    this.timeout(90_000)
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), 'terminal-safe-paste')
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('.titlebar-btn[aria-label="Open terminal"]').click()
    await $('.terminal-container .xterm').waitForExist({ timeout: 30_000 })
    const approval = await $('#approval-dialog').getElement()
    const needsApproval = await approval
      .waitForDisplayed({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false)
    if (needsApproval) {
      await expect(approval.$('.approval-heading')).toHaveText('Open unsandboxed terminal?')
      await approval.$('.approval-approve').click()
      await approval.waitForDisplayed({ reverse: true })
    }
    await browser.waitUntil(async () => (await terminalText()).length > 0, { timeout: 20_000 })
    await $('.terminal-container .xterm-screen').click()
    // A real canonical-mode reader gives deterministic bracketed-paste-off behavior.
    // Its replies distinguish shell input from command-line echo.
    await browser.keys(
      'sh -c \'printf "\\033[?2004l"; printf "PASTE_READER_READY\\n"; while IFS= read -r line; do printf "RECEIVED:%s\\n" "$line"; done\'',
    )
    await browser.keys('Enter')
    // The command itself contains the marker too; require an output row of its own.
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          Array.from(document.querySelectorAll('.xterm-rows > div')).some(
            (row) => row.textContent.trim() === 'PASTE_READER_READY',
          ),
        ),
      { timeout: 10_000 },
    )
  })

  after(() => {
    resetUserData()
  })

  it('holds carriage-return paste for confirmation and sends nothing on Cancel', async () => {
    // The paste event Cmd/Ctrl+V delivers. On Linux that shortcut pastes only
    // through Electron's native Edit-menu accelerator, which WebDriver key events
    // bypass, and xterm turns the raw Ctrl+V into ^V instead.
    await transferText('paste', 'copse-cancelled\r')
    const dialog = await $('#confirm-dialog').getElement()
    await dialog.waitForDisplayed()
    await expect(dialog.$('.confirm-dialog-message')).toHaveText(
      'Paste text that may run commands?',
    )
    await expect(dialog.$('.confirm-dialog-detail')).toHaveText(
      expect.stringContaining('copse-cancelled'),
    )
    expect(await terminalText()).not.toContain('RECEIVED:copse-cancelled')
    await saveAppScreenshot('terminal-unsafe-paste-confirm.png')
    await dialog.$('.confirm-dialog-cancel').click()
    await dialog.waitForDisplayed({ reverse: true })
    expect(await terminalText()).not.toContain('copse-cancelled')
  })

  it('confirms text drops and forwards only sanitized text to the real PTY', async () => {
    await transferText('drop', 'copse\x03accepted\r')
    await $('#confirm-dialog').waitForDisplayed()
    await $('.confirm-dialog-confirm').click()
    await browser.waitUntil(
      async () => (await terminalText()).includes('RECEIVED:copse accepted'),
      { timeout: 10_000 },
    )
    expect(await terminalText()).not.toContain('RECEIVED:copse-cancelled')
  })

  it('preserves ordinary typing and safe single-line paste without confirmation', async () => {
    await transferText('paste', 'ordinary\x15input')
    expect(await $('#confirm-dialog').isDisplayed()).toBe(false)
    await $('.terminal-container .xterm-screen').click()
    await browser.keys('Enter')
    await browser.waitUntil(
      async () => (await terminalText()).includes('RECEIVED:ordinary input'),
      { timeout: 10_000 },
    )
  })

  it('uses the same protection for context-menu paste', async () => {
    await browser.execute(async () => navigator.clipboard.writeText('copse-context\n'))
    await $('.terminal-container .xterm-screen').click({ button: 'right' })
    await $('.context-menu').waitForDisplayed()
    await $('.context-menu-item*=Paste').click()
    await $('#confirm-dialog').waitForDisplayed()
    await $('.confirm-dialog-cancel').click()
    expect(await terminalText()).not.toContain('copse-context')
  })
})
