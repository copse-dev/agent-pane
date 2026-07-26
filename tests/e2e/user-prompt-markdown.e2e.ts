import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedUserPromptMarkdownFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

describe('user prompt markdown in transcript', () => {
  before(async () => {
    mkdirSync(join(process.cwd(), 'tests/e2e/screenshots'), { recursive: true })
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedUserPromptMarkdownFixture(process.cwd())
    await browser.reloadSession()
    await $('[data-message-id="msg-user-markdown"] .message-text').waitForExist({
      timeout: 30_000,
    })
  })

  after(() => {
    resetUserData()
  })

  it('renders settled user prompts with markdown and preserved line breaks', async () => {
    const textEl = await $('[data-message-id="msg-user-markdown"] .message-text')
    await expect(textEl.$('strong')).toExist()
    await expect(textEl.$('br')).toExist()
    await expect(textEl).toHaveText(expect.stringMatching(/line one[\s\S]*line two[\s\S]*bold item/))

    await saveAppScreenshot('user-prompt-markdown.png')
  })
})
