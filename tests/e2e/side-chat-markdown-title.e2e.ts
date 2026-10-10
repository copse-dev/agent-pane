import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedSideChatMarkdownFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

describe('side chat titles and context line read as plain text', () => {
  before(async function () {
    this.timeout(90_000)
    mkdirSync(join(process.cwd(), 'tests/e2e/screenshots'), { recursive: true })
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedSideChatMarkdownFixture(process.cwd())
    await browser.reloadSession()
    await $('[data-message-id="msg-side-chat-anchor"]').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('strips markdown link syntax from the side chat row title and context line', async () => {
    const chip = await $('.msg-side-chat-chip')
    await chip.waitForExist({ timeout: 10_000 })
    await chip.click()

    const rowTitle = await $('.side-chat-row-title')
    await rowTitle.waitForExist({ timeout: 10_000 })
    await expect(rowTitle).toHaveText('PR #3595 is loaded at commit abc')

    const context = await $('[data-side-chat-context]')
    await expect(context).toHaveText(
      'Reads the main thread up to “PR #3595 is loaded at commit abc”. Read-only.',
    )

    await saveAppScreenshot('side-chat-markdown-title.png')
  })
})
