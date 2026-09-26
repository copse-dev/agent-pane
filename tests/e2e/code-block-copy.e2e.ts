import { mkdirSync } from 'node:fs'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedCodeBlockCopyFixture } from './helpers/seed-config.ts'
import { approveUnsandboxedTerminalIfPrompted } from './helpers/terminal-approval.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

describe('code block actions', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedCodeBlockCopyFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('copies examples, and runs shell commands into inline output sent to the agent', async function () {
    this.timeout(90_000)
    const message = await $('[data-message-id="msg-assistant-code-blocks"] .message-text')
    await message.waitForExist({ timeout: 30_000 })

    const codeBlocks = await $$('[data-message-id="msg-assistant-code-blocks"] pre.code-block')
    await expect(codeBlocks).toHaveLength(2)
    await expect($('[data-message-id="msg-assistant-code-blocks"] .hljs-keyword')).toExist()

    const copyButtons = await $$('[data-message-id="msg-assistant-code-blocks"] .code-block-copy')
    await expect(copyButtons).toHaveLength(2)
    const runButtons = await $$('[data-message-id="msg-assistant-code-blocks"] .code-block-run')
    await expect(runButtons).toHaveLength(1)

    const firstBlock = codeBlocks[0]
    const firstCopy = copyButtons[0]
    const runButton = runButtons[0]
    await firstBlock.moveTo()
    await expect(firstCopy).toHaveText('Copy')

    const msgCopyOpacity = await browser.execute(() => {
      const btn = document.querySelector('[data-message-id="msg-assistant-code-blocks"] .msg-copy')
      return btn ? getComputedStyle(btn).opacity : null
    })
    expect(msgCopyOpacity).toBe('0')

    await codeBlocks[1].moveTo()
    await expect(runButton).toHaveAttribute('aria-label', 'Run command')
    await expect(runButton.$('svg[data-icon="play"]')).toExist()
    await saveAppScreenshot('code-block-run-hover.png')

    await firstCopy.click()
    await expect(firstCopy).toHaveText('Copied')
    const clipboardText = await browser.execute(async () => navigator.clipboard.readText())
    expect(clipboardText).toMatch(/^export function greet/)
    expect(clipboardText).toContain('Hello, ${name}!')

    const reply = 'The command printed 424242 and exited cleanly.'
    await installMockScenario({
      title: 'Read a Play result',
      turns: [{ user: { includes: '424242' }, responses: [{ text: reply }] }],
    })
    await runButton.click()
    await approveUnsandboxedTerminalIfPrompted()

    const output = await $(
      '[data-message-id="msg-assistant-code-blocks"] .code-block-shell > .code-block-output',
    )
    await output.waitForDisplayed({ timeout: 30_000 })
    await browser.waitUntil(
      async () => (await output.getAttribute('data-run-state')) !== 'running',
      {
        timeout: 30_000,
        timeoutMsg: 'the run never reported its exit',
      },
    )
    await expect(runButton).toHaveAttribute('data-run-state', 'succeeded')
    await expect(output.$('summary')).toHaveText('Output · exit 0')
    await expect(output.$('.code-block-output-text')).toHaveText(expect.stringContaining('424242'))

    // The result goes to the agent as the next user message; nothing is left
    // waiting on the draft for a Send.
    const sent = await $('.msg-user .transcript-attachment-shell')
    await sent.waitForDisplayed({ timeout: 30_000 })
    await expect(sent.$('.transcript-attachment-label')).toHaveText(
      expect.stringContaining('exit 0'),
    )
    await expect($('.attachment-chip.shell-chip')).not.toExist()

    await sent.click()
    const preview = await $('dialog.attachment-preview-dialog[open]')
    await preview.waitForDisplayed({ timeout: 10_000 })
    await expect(preview.$('.attachment-preview-text')).toHaveText(
      expect.stringContaining('424242'),
    )
    await preview.$('.attachment-preview-close').click()
    await expectAssistantReply(reply)

    await output.scrollIntoView({ block: 'center' })
    await saveAppScreenshot('code-block-run-output-sent.png')
  })
})
