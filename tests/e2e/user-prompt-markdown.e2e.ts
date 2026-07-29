import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedUserPromptMarkdownFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

describe('user prompt markdown in transcript', () => {
  before(async function () {
    this.timeout(90_000)
    mkdirSync(join(process.cwd(), 'tests/e2e/screenshots'), { recursive: true })
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    // The app from the previous spec is still alive while this fixture is
    // written and can race by persisting its old project once more. Reinforce
    // the seed across one fresh-session retry on slower hosted runners.
    for (const timeout of [10_000, 30_000]) {
      resetUserData()
      seedUserPromptMarkdownFixture(process.cwd())
      await browser.reloadSession()
      try {
        await $('[data-message-id="msg-user-markdown"] .message-text').waitForExist({ timeout })
        return
      } catch (error) {
        if (timeout === 30_000) throw error
      }
    }
  })

  after(() => {
    resetUserData()
  })

  it('renders settled user prompts with markdown and preserved line breaks', async () => {
    const textEl = await $('[data-message-id="msg-user-markdown"] .message-text')
    await expect(textEl.$('strong')).toExist()
    await expect(textEl.$('br')).toExist()
    await expect(textEl).toHaveText(
      expect.stringMatching(/line one[\s\S]*line two[\s\S]*bold item/),
    )

    await saveAppScreenshot('user-prompt-markdown.png')
  })
})
