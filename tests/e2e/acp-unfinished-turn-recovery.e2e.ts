import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedAcpUnfinishedTurnFixture } from './helpers/seed-config.ts'
import { savePreparedElementScreenshot } from './helpers/screenshot.ts'

describe('ACP unfinished-turn recovery fallback', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedAcpUnfinishedTurnFixture(process.cwd())
    await browser.reloadSession()
    await $('[data-message-id="msg-assistant-acp-fallback"] .message-text').waitForExist({
      timeout: 30_000,
    })
  })

  after(() => {
    resetUserData()
  })

  it('places the recovery fallback after the completed tool trace', async () => {
    const toolCard = await $('.tool-card[data-tool-id="tc-acp-upstream-search"]')
    const fallback = await $('[data-message-id="msg-assistant-acp-fallback"] .message-text')
    await expect(toolCard).toHaveAttribute('data-status', 'done')
    await expect(fallback).toHaveText(
      'The external agent stopped after using its tools without providing a final result. Send “continue” to resume.',
    )

    const positions = await browser.execute(() => {
      const tool = document.querySelector('.tool-card[data-tool-id="tc-acp-upstream-search"]')
      const answer = document.querySelector(
        '[data-message-id="msg-assistant-acp-fallback"] .message-text',
      )
      if (!tool || !answer) return null
      return {
        toolBottom: tool.getBoundingClientRect().bottom,
        fallbackTop: answer.getBoundingClientRect().top,
      }
    })
    expect(positions).not.toBeNull()
    expect(positions?.fallbackTop ?? 0).toBeGreaterThan(positions?.toolBottom ?? 0)

    await savePreparedElementScreenshot('.messages-list', 'acp-unfinished-turn-recovery.png')
  })
})
