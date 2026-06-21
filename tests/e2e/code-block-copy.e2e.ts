import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedCodeBlockCopyFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('code block copy buttons', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedCodeBlockCopyFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows per-block copy buttons with hover and copied feedback', async () => {
    const message = await $('[data-message-id="msg-assistant-code-blocks"] .message-text')
    await message.waitForExist({ timeout: 15_000 })

    const codeBlocks = await $$('[data-message-id="msg-assistant-code-blocks"] pre.code-block')
    await expect(codeBlocks).toHaveLength(2)

    await expect($('[data-message-id="msg-assistant-code-blocks"] .hljs-keyword')).toExist()

    const copyButtons = await $$('[data-message-id="msg-assistant-code-blocks"] .code-block-copy')
    await expect(copyButtons).toHaveLength(2)

    const firstBlock = codeBlocks[0]
    const firstCopy = copyButtons[0]
    await firstBlock.moveTo()
    await expect(firstCopy).toHaveText('Copy')

    const msgCopyOpacity = await browser.execute(() => {
      const btn = document.querySelector('[data-message-id="msg-assistant-code-blocks"] .msg-copy')
      return btn ? getComputedStyle(btn).opacity : null
    })
    expect(msgCopyOpacity).toBe('0')

    const secondCopyOpacity = await browser.execute(() => {
      const buttons = document.querySelectorAll(
        '[data-message-id="msg-assistant-code-blocks"] .code-block-copy',
      )
      return buttons[1] ? getComputedStyle(buttons[1]).opacity : null
    })
    expect(secondCopyOpacity).toBe('0')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'code-block-copy-hover.png'))

    await firstCopy.click()
    await expect(firstCopy).toHaveText('Copied')

    const clipboardText = await browser.execute(async () => navigator.clipboard.readText())
    expect(clipboardText).toMatch(/^export function greet/)
    expect(clipboardText).toContain('Hello, ${name}!')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'code-block-copy-copied.png'))
  })
})
