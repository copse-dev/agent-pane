import { $, browser, expect } from '@wdio/globals'
import { delimiter, join } from 'node:path'
import {
  resetUserData,
  seedAcpAuthErrorFixture,
  seedE2eViewport,
  seedEmptyProject,
} from './helpers/seed-config.ts'
import { saveAppScreenshot, savePreparedElementScreenshot } from './helpers/screenshot.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'

/**
 * Protocol jargon stays out of everyday surfaces. Pairs with the source scan in
 * `scripts/user-copy-jargon.test.ts`: that guards the strings, this proves the
 * words a person actually reads on the three surfaces the rewrite changed — the
 * install approval, the Codex card in Settings, and an agent error banner.
 *
 * `pre` blocks are the "Technical details" disclosure, where the exact protocol
 * code is deliberately kept for bug reports, so they are excluded from the scan.
 */
const JARGON = /\b(?:ACP|ASRT|IPC|JSON-RPC|stdio|harness)\b/

/** Visible text under `selector`, minus code fences and the monospace package names. */
async function proseOf(selector: string): Promise<string> {
  return browser.execute((sel) => {
    const root = document.querySelector(sel)
    if (!root) return ''
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const parts: string[] = []
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest('pre, code')) continue
      parts.push(node.textContent ?? '')
    }
    return parts.join(' ')
  }, selector)
}

/** Asserts `selector` has real prose and none of it is protocol jargon. */
async function expectPlainLanguage(selector: string): Promise<void> {
  const prose = await proseOf(selector)
  // An empty read would pass the jargon check for the wrong reason.
  expect(prose.trim().length).toBeGreaterThan(40)
  expect(prose).not.toMatch(JARGON)
}

describe('plain-language copy: Settings and the install approval', () => {
  const originalPath = process.env['PATH']
  const originalPreservePath = process.env['COPSE_PRESERVE_PATH']

  before(async () => {
    resetUserData()
    // Isolate adapter detection from ambient host CLIs so the approval is the
    // genuine fresh-install consent, as in settings-chatgpt-plan.e2e.ts.
    writeE2eEnv({
      COPSE_PRESERVE_PATH: '1',
      PATH: (process.platform === 'win32'
        ? [join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')]
        : ['/usr/bin', '/bin']
      ).join(delimiter),
    })
    seedEmptyProject(process.cwd(), 'e2e-plain-language', {
      registeredAcpAgents: [
        { id: 'codex-acp', title: 'Codex', command: 'codex-acp', enabled: true },
      ],
    })
    seedE2eViewport({ width: 1280, height: 800 })
    await browser.reloadSession()
  })

  after(() => {
    writeE2eEnv({ COPSE_PRESERVE_PATH: originalPreservePath, PATH: originalPath })
    resetUserData()
  })

  it('asks to install “software to connect your coding agents” and names the Codex card for what it is', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-providers-host .provider-chip[data-provider="openai"]').click()

    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await expect(dialog.$('.approval-heading')).toHaveText(
      'Install software to connect your coding agents?',
    )
    await expect(dialog.$('.approval-body')).toHaveText('communicate with your coding agents', {
      containing: true,
    })
    await expectPlainLanguage('#approval-dialog')
    await saveAppScreenshot('plain-language-install-approval.png')

    await dialog.$('.approval-reject').click()
    await expect(dialog).not.toBeDisplayed()

    const codexCard = $('.openai-connection-card[data-connection="codex"]')
    await expect(codexCard.$('h4')).toHaveText('Codex agent')
    await expect(codexCard).toHaveText('Codex’s agent, running on this machine.', {
      containing: true,
    })
    await $('[data-testid="openai-codex-details"] summary').click()
    await expect($('[data-testid="openai-codex-details"] summary')).toHaveText(
      'Configure Codex agent',
      { containing: true },
    )

    await expectPlainLanguage('#settings-providers-host')
    await $('#settings-providers-host').scrollIntoView()
    await saveAppScreenshot('plain-language-settings-codex-agent.png')
  })
})

describe('plain-language copy: agent error banner', () => {
  beforeEach(async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
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

  it('leads with recovery in plain words and keeps the protocol code in Technical details', async () => {
    const message = '[data-message-id="msg-assistant-acp-auth"] .message-text'
    await expect($(`${message} .markdown-alert-warning strong`)).toHaveText(
      'Claude sign-in expired',
    )
    // The headline and steps a user reads carry no protocol names…
    await expectPlainLanguage(message)
    // …while the exact code is still there, in the fenced Technical details.
    await expect($(`${message} pre code`)).toHaveText(
      expect.stringContaining('ACP error -32603 (Internal error)'),
    )
    await savePreparedElementScreenshot(
      '[data-message-id="msg-assistant-acp-auth"]',
      'plain-language-agent-error-banner.png',
    )
  })
})
