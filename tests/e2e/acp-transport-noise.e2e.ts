import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedAcpTransportNoiseFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

describe('ACP transport noise demotion', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedAcpTransportNoiseFixture(process.cwd())
    await browser.reloadSession()
    await $('[data-message-id="msg-assistant-acp-noise"] .message-text').waitForExist({
      timeout: 30_000,
    })
  })

  after(() => {
    resetUserData()
  })

  it('keeps the PR URL prominent and collapses the Cursor RetriableError in developer mode', async () => {
    const state = await browser.execute(() => {
      const text = document.querySelector(
        '[data-message-id="msg-assistant-acp-noise"] .message-text',
      )
      const details = document.querySelector<HTMLDetailsElement>(
        '[data-message-id="msg-assistant-acp-noise"] .acp-transport-noise',
      )
      return {
        answerText: text?.textContent ?? '',
        hasDisclosure: details !== null,
        disclosureOpen: details?.open ?? false,
        summary: details?.querySelector('.acp-transport-noise-summary')?.textContent ?? '',
        noise: details?.querySelector('.acp-transport-noise-body')?.textContent ?? '',
      }
    })

    expect(state.answerText).toContain('pull/1818')
    expect(state.answerText).not.toContain('WritableIterable')
    expect(state.hasDisclosure).toBe(true)
    expect(state.disclosureOpen).toBe(false)
    expect(state.summary).toBe('Agent transport note')
    expect(state.noise).toContain('WritableIterable is closed')

    await saveAppScreenshot('acp-transport-noise-collapsed.png')
  })
})
