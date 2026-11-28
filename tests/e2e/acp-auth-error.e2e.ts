import { $, browser, expect } from '@wdio/globals'
import { join } from 'node:path'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { waitForAgentIdle } from './helpers.ts'
import {
  resetUserData,
  seedAcpAuthErrorFixture,
  seedEmptyProject,
  seedStableWorkspace,
} from './helpers/seed-config.ts'
import { prepareE2eScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'

async function saveAuthMessage(selector: string, filename: string): Promise<void> {
  await prepareE2eScreenshot()
  if (await $('#pane-projects').isDisplayed()) await $('[aria-label="Toggle sidebar"]').click()
  await $(selector).scrollIntoView({ block: 'center' })
  const bounds = await browser.execute((sel) => {
    for (const block of document.querySelectorAll<HTMLElement>(`${sel} pre`)) block.scrollLeft = 0
    const messageNode = document.querySelector(sel)
    const composerNode = document.querySelector('#input-bar')
    const transcriptNode = document.querySelector('.conversation-scroll')
    if (!messageNode || !composerNode || !transcriptNode) throw new Error('Missing capture layout')
    const message = messageNode.getBoundingClientRect()
    const composer = composerNode.getBoundingClientRect()
    const transcript = transcriptNode.getBoundingClientRect()
    return {
      top: message.top,
      bottom: message.bottom,
      viewportTop: transcript.top,
      composerTop: composer.top,
    }
  }, selector)
  expect(bounds.top).toBeGreaterThanOrEqual(bounds.viewportTop)
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.composerTop)
  await saveElementScreenshot(selector, filename, { frame: 'document' })
}

/**
 * Where each env-var hint rendered: inside the numbered sign-in steps (the
 * markdown package folds a trailing unindented paragraph into the last ordered
 * item) or in the credentials note that follows them.
 */
async function hintPlacement(
  messageId: string,
): Promise<{ inSteps: (string | null)[]; inNote: (string | null)[] }> {
  return browser.execute((id) => {
    const root = document.querySelector(`[data-message-id="${id}"] .message-text`)
    const codeText = (selector: string): (string | null)[] =>
      [...(root?.querySelectorAll(selector) ?? [])].map((code) => code.textContent)
    return {
      inSteps: codeText('ol code'),
      inNote: codeText('blockquote:not(.markdown-alert) code'),
    }
  }, messageId)
}

describe('ACP authentication error presentation', () => {
  const originalPath = process.env['PATH']
  const originalPreservePath = process.env['COPSE_PRESERVE_PATH']
  // Screenshot preparation changes the frame and overflow. Each recovery path
  // needs a fresh viewport so one capture cannot clip the next message's prose.
  beforeEach(async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
    resetUserData()
    // This fixture exercises sign-in guidance, not installed host CLIs. A host
    // Codex binary can otherwise trigger a late adapter-install approval over
    // the Claude panel after its text assertions have already passed.
    writeE2eEnv({
      COPSE_PRESERVE_PATH: '1',
      PATH:
        process.platform === 'win32'
          ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')
          : '/usr/bin:/bin',
    })
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
    await $('[data-message-id="msg-assistant-claude-org-auth"] .message-text').waitForExist({
      timeout: 30_000,
    })
    await $('[data-message-id="msg-assistant-claude-store-refused"] .message-text').waitForExist({
      timeout: 30_000,
    })
  })

  after(() => {
    writeE2eEnv({ COPSE_PRESERVE_PATH: originalPreservePath, PATH: originalPath })
    resetUserData()
  })

  it('shows the bundled Claude sign-in command on a fresh machine', async () => {
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').waitForDisplayed({ timeout: 10_000 })
    await $('[data-testid="connections-add-toggle"]').click()
    await $('.acp-add-row[data-agent="claude-acp"]').$('button=Set up').click()
    // Provider discovery can find a host client outside PATH and offer its
    // adapter. Decline through the real UI before reviewing sign-in guidance.
    const approval = $('#approval-dialog')
    const offeredInstall = await approval.waitForDisplayed({ timeout: 10_000 }).then(
      () => true,
      () => false,
    )
    if (offeredInstall) {
      await expect(approval.$('.approval-heading')).toHaveText(
        'Install software to connect your coding agents?',
      )
      await approval.$('.approval-reject').click()
      await expect(approval).not.toBeDisplayed()
    }
    const signIn = await $('.acp-cmd-row*=Sign in')
    await expect(signIn.$('.acp-cmd')).toHaveText('claude-agent-acp --cli auth login')
    const note = await $('.acp-known-agent-note')
    await expect(note).toHaveText(expect.stringContaining('claude-agent-acp --cli auth login'))
    await expect(note).toHaveText(expect.stringContaining('ANTHROPIC_API_KEY'))
    await expect(note).not.toHaveText(expect.stringContaining('setup-token'))
    await expect(signIn).not.toHaveText(expect.stringContaining('--sso'))
    await expect($('#approval-dialog')).not.toBeDisplayed()
    await saveElementScreenshot('.acp-add-menu .provider-form', 'claude-sign-in.png')
  })

  it('leads with recovery and keeps opaque ACP diagnostics subordinate', async () => {
    const message = await $('[data-message-id="msg-assistant-acp-auth"] .message-text').getElement()
    const warning = await message.$('.markdown-alert-warning').getElement()
    await expect(warning.$('strong')).toHaveText('Claude sign-in expired')
    await expect(message.$('ol code')).toHaveText('claude-agent-acp --cli auth login')
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
      if (!root || !warningEl || !steps || !diagnostic) throw new Error('missing auth error block')
      const rootRect = root.getBoundingClientRect()
      const diagnosticRect = diagnostic.getBoundingClientRect()
      const diagnosticStyle = getComputedStyle(diagnostic)
      const diagnosticLines = diagnostic.textContent.trimEnd().split('\n').length
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
    // Fenced diagnostics use code density, not the 15px/1.6 prose line box
    // (~26px per 12px line before #3065).
    expect(layout.diagnosticLines).toBe(2)
    expect(layout.diagnosticFontSize).toBe(12)
    expect(layout.diagnosticLinePitch).toBeGreaterThanOrEqual(21)
    expect(layout.diagnosticLinePitch).toBeLessThanOrEqual(24)

    const hints = await hintPlacement('msg-assistant-acp-auth')
    expect(hints.inSteps).toEqual(['claude-agent-acp --cli auth login'])
    expect(hints.inNote).toEqual(['ANTHROPIC_API_KEY'])

    await saveAuthMessage('[data-message-id="msg-assistant-acp-auth"]', 'acp-auth-error.png')
  })

  it("shows Cursor's rejected session as an expired sign-in with its own recovery path", async () => {
    const message = await $(
      '[data-message-id="msg-assistant-cursor-auth"] .message-text',
    ).getElement()
    const warning = await message.$('.markdown-alert-warning').getElement()
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

    await saveAuthMessage(
      '[data-message-id="msg-assistant-cursor-auth"]',
      'cursor-acp-auth-error.png',
    )
  })

  it('shows workspace-routing 401 recovery as an expired Codex sign-in', async () => {
    const message = await $(
      '[data-message-id="msg-assistant-codex-auth"] .message-text',
    ).getElement()
    const warning = await message.$('.markdown-alert-warning').getElement()
    await expect(warning.$('strong')).toHaveText('Codex sign-in expired')
    await expect(message.$('ol code')).toHaveText('codex-acp cli login')
    const paragraphCodeText = await message.$$('p code').map((code) => code.getText())
    expect(paragraphCodeText).toContain('CODEX_API_KEY')
    expect(paragraphCodeText).toContain('OPENAI_API_KEY')
    const hints = await hintPlacement('msg-assistant-codex-auth')
    expect(hints.inSteps).toEqual(['codex-acp cli login'])
    expect(hints.inNote).toEqual(['CODEX_API_KEY', 'OPENAI_API_KEY'])
    await expect(message.$('pre code')).toHaveText(
      expect.stringContaining('workspace routing discovery unauthorized (401)'),
    )

    await $('.context-wheel.has-breakdown').waitForDisplayed({ timeout: 15_000 })
    await saveAuthMessage(
      '[data-message-id="msg-assistant-codex-auth"]',
      'codex-workspace-routing-auth-error.png',
    )
  })

  // #4147: Claude Code's organization check exits the agent with a raw -32603
  // that reads like a network blip. The thread must say the sign-in couldn't be
  // verified, why that is usually a stale sign-in, what to do if it was the
  // network, and how to sign in, before the agent's own words.
  it("explains Claude's failed organization check as an unverified sign-in", async () => {
    const message = await $(
      '[data-message-id="msg-assistant-claude-org-auth"] .message-text',
    ).getElement()
    const warning = await message.$('.markdown-alert-warning').getElement()
    await expect(warning.$('strong')).toHaveText('Claude couldn’t verify its sign-in')
    const cause = await message.$('p*=organization’s policy').getElement()
    await expect(cause).toHaveText(
      expect.stringContaining('can’t save the new one to the macOS Keychain'),
    )
    await expect(cause).toHaveText(
      expect.stringContaining('If your network was down instead, re-send your message'),
    )
    await expect(message.$('ol code')).toHaveText('claude-agent-acp --cli auth login')
    await expect(message.$('pre code')).toHaveText(
      expect.stringContaining('Unable to verify organization for the current authentication token'),
    )

    const order = await browser.execute(() => {
      const root = document.querySelector(
        '[data-message-id="msg-assistant-claude-org-auth"] .message-text',
      )
      const warningEl = root?.querySelector('.markdown-alert-warning')
      const causeEl = [...(root?.querySelectorAll(':scope > p') ?? [])].find((p) =>
        p.textContent.includes('organization’s policy'),
      )
      const steps = root?.querySelector('ol')
      const diagnostic = root?.querySelector('pre')
      if (!warningEl || !causeEl || !steps || !diagnostic)
        throw new Error('missing org-check block')
      const below = (a: Element, b: Element): boolean =>
        a.getBoundingClientRect().bottom <= b.getBoundingClientRect().top
      return {
        warningBeforeCause: below(warningEl, causeEl),
        causeBeforeSteps: below(causeEl, steps),
        stepsBeforeDiagnostic: below(steps, diagnostic),
      }
    })
    expect(order).toEqual({
      warningBeforeCause: true,
      causeBeforeSteps: true,
      stepsBeforeDiagnostic: true,
    })

    await saveAuthMessage(
      '[data-message-id="msg-assistant-claude-org-auth"]',
      'claude-org-check-auth-error.png',
    )
  })

  // Inside Copse's sandbox the Keychain is read-only, so Claude Code refuses
  // to renew an expired access token it could not save, and every turn died
  // on a raw -32603 until something outside renewed it. The thread must say
  // the sign-in is still good, why the sandbox blocks the renewal, how to
  // renew it now and how to stop it recurring, before the agent's own words.
  it('explains a Keychain save the sandbox refused as a renewal Claude could not make', async () => {
    const selector = '[data-message-id="msg-assistant-claude-store-refused"]'
    const message = await $(`${selector} .message-text`).getElement()
    const warning = await message.$('.markdown-alert-warning').getElement()
    await expect(warning.$('strong')).toHaveText('Claude couldn’t renew its sign-in')
    await expect(message.$('p*=Your sign-in itself is still valid')).toHaveText(
      expect.stringContaining('read the macOS Keychain but not write to it'),
    )
    await expect(message.$('ol code')).toHaveText('claude-agent-acp --cli auth login')
    const hints = await hintPlacement('msg-assistant-claude-store-refused')
    expect(hints.inSteps).toEqual(['claude-agent-acp --cli auth login'])
    expect(hints.inNote).toEqual(['claude setup-token', 'CLAUDE_CODE_OAUTH_TOKEN'])
    await expect(message.$('pre code')).toHaveText(
      expect.stringContaining("Failed to refresh OAuth token: can't save to the Keychain"),
    )
    await saveAuthMessage(selector, 'claude-keychain-store-refused-auth-error.png')
  })
})

// Found dogfooding #4278: Claude's OAuth sign-in expired mid-turn. Claude Agent
// ACP streamed the CLI's synthetic "Failed to authenticate: OAuth session
// expired…" message under its own message id, then failed the prompt with a
// bare -32000. The notice was glued onto that text, so its alert rendered as a
// raw `[!WARNING]` line, and it said "not signed in" instead of "expired". The
// mock agent (`fail-auth-after:`) drives that exact sequence for real.
describe('ACP sign-in that expires mid-turn', function () {
  this.timeout(120_000)
  const originalPath = process.env['PATH']
  const originalPreservePath = process.env['COPSE_PRESERVE_PATH']
  const streamed = 'Failed to authenticate: OAuth session expired and could not be refreshed'

  before(async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
    resetUserData()
    writeE2eEnv({
      COPSE_PRESERVE_PATH: '1',
      PATH:
        process.platform === 'win32'
          ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')
          : '/usr/bin:/bin',
    })
    seedEmptyProject(seedStableWorkspace(), 'e2e-acp-auth-expired-mid-turn', {
      model: 'acp:claude-acp#fixture-model',
      registeredAcpAgents: [
        // Keep an ambient Codex CLI's adapter-install approval out of this journey.
        { id: 'codex-acp', title: 'Codex', command: 'codex-acp', enabled: false },
        {
          id: 'claude-acp',
          title: 'Claude',
          command: process.execPath,
          args: [join(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs')],
          // The catalog seatbelt cannot read a fixture outside the workspace;
          // this journey is about the failure copy, so opt out as a user can.
          sandbox: false,
          enabled: true,
          model: 'fixture-model',
          availableModels: [{ value: 'fixture-model', label: 'Fixture model' }],
          modelsProbedAt: Date.now(),
        },
      ],
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    writeE2eEnv({ COPSE_PRESERVE_PATH: originalPreservePath, PATH: originalPath })
    resetUserData()
  })

  it('shows the expired sign-in as its own alert after the agent’s words', async () => {
    await setComposerValue(`fail-auth-after:${streamed}`)
    await submitComposer()

    // The sign-in offer, when a terminal can run it, names the same verdict.
    const offer = $('#ask-user-dialog')
    const offered = await offer.waitForDisplayed({ timeout: 20_000 }).then(
      () => true,
      () => false,
    )
    if (offered) {
      await expect(offer.$('.ask-user-question')).toHaveText(
        expect.stringContaining('saved sign-in has expired'),
      )
      await offer.$('.ask-user-option=Not now').click()
    }
    await waitForAgentIdle(30_000)

    const messageId = await browser.waitUntil(
      () =>
        browser.execute(() => {
          const last = [...document.querySelectorAll('.messages-list .msg-assistant')].at(-1)
          if (!last || document.querySelector('.messages-list .is-streaming')) return false
          if (!last.querySelector('.markdown-alert-warning')) return false
          return last.getAttribute('data-message-id') ?? false
        }),
      { timeout: 30_000, interval: 100, timeoutMsg: 'the sign-in alert did not render' },
    )
    const selector = `[data-message-id="${messageId}"]`
    const message = await $(`${selector} .message-text`).getElement()
    const warning = await message.$('.markdown-alert-warning').getElement()
    await expect(warning.$('strong')).toHaveText('Claude sign-in expired')
    await expect(message.$('ol code')).toHaveText('claude-agent-acp --cli auth login')
    await expect(message.$('pre code')).toHaveText(
      expect.stringContaining('ACP error -32000 (Authentication required)'),
    )
    // The agent's words stay a paragraph of their own, ahead of the alert, and
    // no alert marker leaks into the prose.
    const layout = await browser.execute((sel) => {
      const root = document.querySelector(`${sel} .message-text`)
      const first = root?.firstElementChild
      const alert = root?.querySelector('.markdown-alert-warning')
      return {
        text: root?.textContent ?? '',
        first: first?.tagName === 'P' ? first.textContent : null,
        firstAboveAlert:
          first && alert
            ? first.getBoundingClientRect().bottom <= alert.getBoundingClientRect().top
            : false,
      }
    }, selector)
    expect(layout.first).toBe(streamed)
    expect(layout.firstAboveAlert).toBe(true)
    expect(layout.text).not.toContain('[!WARNING]')
    expect(layout.text).not.toContain('needs authentication')

    await saveAuthMessage(selector, 'acp-auth-expired-mid-turn.png')
  })
})
