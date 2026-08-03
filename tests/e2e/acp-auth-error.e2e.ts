import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedAcpAuthErrorFixture } from './helpers/seed-config.ts'
import { savePreparedElementScreenshot } from './helpers/screenshot.ts'

describe('ACP authentication error presentation', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedAcpAuthErrorFixture(process.cwd())
    await browser.reloadSession()
    await $('[data-message-id="msg-assistant-acp-auth"] .message-text').waitForExist({
      timeout: 30_000,
    })
  })

  after(() => {
    resetUserData()
  })

  it('leads with recovery and keeps opaque ACP diagnostics subordinate', async () => {
    const message = await $('[data-message-id="msg-assistant-acp-auth"] .message-text')
    const warning = await message.$('.markdown-alert-warning')
    await expect(warning.$('strong')).toHaveText('Claude sign-in expired')
    await expect(message.$('ol code')).toHaveText('claude /login')
    await expect(message.$('pre code')).toHaveText(
      expect.stringContaining('ACP error -32603 (Internal error)'),
    )

    const layout = await browser.execute(() => {
      const root = document.querySelector<HTMLElement>(
        '[data-message-id="msg-assistant-acp-auth"] .message-text',
      )
      const warningEl = root?.querySelector('.markdown-alert-warning')
      const steps = root?.querySelector('ol')
      const diagnostic = root?.querySelector('pre')
      if (!root || !warningEl || !steps || !diagnostic) return { error: 'missing auth error block' }
      const rootRect = root.getBoundingClientRect()
      const diagnosticRect = diagnostic.getBoundingClientRect()
      return {
        warningBeforeSteps:
          warningEl.getBoundingClientRect().bottom <= steps.getBoundingClientRect().top,
        stepsBeforeDiagnostic: steps.getBoundingClientRect().bottom <= diagnosticRect.top,
        diagnosticContained: diagnosticRect.right <= rootRect.right + 1,
      }
    })
    expect(layout).not.toHaveProperty('error')
    expect(layout.warningBeforeSteps).toBe(true)
    expect(layout.stepsBeforeDiagnostic).toBe(true)
    expect(layout.diagnosticContained).toBe(true)

    await savePreparedElementScreenshot(
      '[data-message-id="msg-assistant-acp-auth"]',
      'acp-auth-error.png',
    )
  })
})
