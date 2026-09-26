import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedAcpAuthErrorFixture } from './helpers/seed-config.ts'
import { savePreparedElementScreenshot } from './helpers/screenshot.ts'

/**
 * Where each env-var hint rendered: inside the numbered sign-in steps (the
 * markdown package folds a trailing unindented paragraph into the last ordered
 * item) or in the credentials note that follows them.
 */
async function hintPlacement(messageId: string) {
  return browser.execute((id) => {
    const root = document.querySelector(`[data-message-id="${id}"] .message-text`)
    const codeText = (selector: string) =>
      [...(root?.querySelectorAll(selector) ?? [])].map((code) => code.textContent)
    return {
      inSteps: codeText('ol code'),
      inNote: codeText('blockquote:not(.markdown-alert) code'),
    }
  }, messageId)
}

describe('ACP authentication error presentation', () => {
  // Screenshot preparation changes the frame and overflow. Each recovery path
  // needs a fresh viewport so one capture cannot clip the next message's prose.
  beforeEach(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedAcpAuthErrorFixture(process.cwd())
    await browser.reloadSession()
    await $('[data-message-id="msg-assistant-acp-auth"] .message-text').waitForExist({
      timeout: 30_000,
    })
    await $('[data-message-id="msg-assistant-cursor-auth"] .message-text').waitForExist({
      timeout: 30_000,
    })
    await $('[data-message-id="msg-assistant-codex-auth"] .message-text').waitForExist({
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
      const diagnosticStyle = getComputedStyle(diagnostic)
      const diagnosticLines = (diagnostic.textContent ?? '').trimEnd().split('\n').length
      const diagnosticContentHeight =
        diagnostic.clientHeight -
        parseFloat(diagnosticStyle.paddingTop) -
        parseFloat(diagnosticStyle.paddingBottom)
      return {
        diagnosticLines,
        diagnosticFontSize: parseFloat(diagnosticStyle.fontSize),
        diagnosticLinePitch: diagnosticContentHeight / diagnosticLines,
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
    // Fenced diagnostics use code density, not the 16px/1.65 prose line box
    // (~26px per 12px line before #3065).
    expect(layout.diagnosticLines).toBe(2)
    expect(layout.diagnosticFontSize).toBe(12)
    expect(layout.diagnosticLinePitch).toBeGreaterThanOrEqual(21)
    expect(layout.diagnosticLinePitch).toBeLessThanOrEqual(24)

    const hints = await hintPlacement('msg-assistant-acp-auth')
    expect(hints.inSteps).toEqual(['claude /login'])
    expect(hints.inNote).toEqual(['ANTHROPIC_API_KEY'])

    await savePreparedElementScreenshot(
      '[data-message-id="msg-assistant-acp-auth"]',
      'acp-auth-error.png',
    )
  })

  it("shows Cursor's rejected session as an expired sign-in with its own recovery path", async () => {
    const message = await $('[data-message-id="msg-assistant-cursor-auth"] .message-text')
    const warning = await message.$('.markdown-alert-warning')
    await expect(warning.$('strong')).toHaveText('Cursor sign-in expired')
    await expect(message.$('ol code')).toHaveText('cursor-agent login')
    // Check the complete prose token set for the recovery hint.
    const paragraphCodeText = await message.$$('p code').map((code) => code.getText())
    expect(paragraphCodeText).toContain('CURSOR_SESSION_TOKEN')
    const hints = await hintPlacement('msg-assistant-cursor-auth')
    expect(hints.inSteps).toEqual(['cursor-agent login'])
    expect(hints.inNote).toEqual(['CURSOR_SESSION_TOKEN'])
    await expect(message.$('pre code')).toHaveText(
      expect.stringContaining('expired WorkosCursorSessionToken'),
    )

    await savePreparedElementScreenshot(
      '[data-message-id="msg-assistant-cursor-auth"]',
      'cursor-acp-auth-error.png',
    )
  })

  it('shows workspace-routing 401 recovery as an expired Codex sign-in', async () => {
    const message = await $('[data-message-id="msg-assistant-codex-auth"] .message-text')
    const warning = await message.$('.markdown-alert-warning')
    await expect(warning.$('strong')).toHaveText('Codex sign-in expired')
    await expect(message.$('ol code')).toHaveText('codex login')
    const paragraphCodeText = await message.$$('p code').map((code) => code.getText())
    expect(paragraphCodeText).toContain('CODEX_API_KEY')
    expect(paragraphCodeText).toContain('OPENAI_API_KEY')
    const hints = await hintPlacement('msg-assistant-codex-auth')
    expect(hints.inSteps).toEqual(['codex login'])
    expect(hints.inNote).toEqual(['CODEX_API_KEY', 'OPENAI_API_KEY'])
    await expect(message.$('pre code')).toHaveText(
      expect.stringContaining('workspace routing discovery unauthorized (401)'),
    )

    await savePreparedElementScreenshot(
      '[data-message-id="msg-assistant-codex-auth"]',
      'codex-workspace-routing-auth-error.png',
    )
  })
})
