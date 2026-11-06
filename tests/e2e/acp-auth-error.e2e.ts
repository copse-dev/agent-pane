import { $, browser, expect } from '@wdio/globals'
import { join } from 'node:path'
import { resetUserData, seedAcpAuthErrorFixture, seedE2eViewport } from './helpers/seed-config.ts'
import { prepareE2eScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'

// Each capture centres one sign-in message in the transcript and requires it to
// clear the composer. The Claude organization-check message is about 578px
// tall, which left about 1px of room in the default 800px window, so a 2px
// layout difference between runs failed the fit. The extra height keeps every
// message clear; the captures are of the message alone, so they do not change.
const AUTH_VIEWPORT = { width: 1280, height: 900 } as const

async function saveAuthMessage(selector: string, filename: string): Promise<void> {
  await prepareE2eScreenshot(AUTH_VIEWPORT)
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
  // TEMPORARY DIAGNOSTIC (revert before review)
  await logFontDiag(filename, 'before')
  expect(bounds.top).toBeGreaterThanOrEqual(bounds.viewportTop)
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.composerTop)
  await saveElementScreenshot(selector, filename, { frame: 'document' })
  await logFontDiag(filename, 'after')
}

// TEMPORARY DIAGNOSTIC (revert before review): font, stylesheet and document
// state at each capture.
async function logFontDiag(filename: string, phase: string): Promise<void> {
  const diag = await browser.execute(() => {
    const blocks = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.messages-list .message-text code, .messages-list .message-text pre',
      ),
    ).slice(0, 12)
    const families = new Set<string>()
    const perBlock = blocks.map((block) => {
      const style = getComputedStyle(block)
      families.add(style.fontFamily)
      let ready: boolean | string
      try {
        ready = document.fonts.check(`${style.fontSize} ${style.fontFamily}`)
      } catch {
        ready = 'error'
      }
      return `${block.tagName.toLowerCase()} ${String(block.getBoundingClientRect().height)} ${style.fontFamily.slice(0, 40)} ready=${String(ready)}`
    })
    return {
      at: Math.round(performance.now()),
      fontsStatus: document.fonts.status,
      faces: Array.from(
        document.fonts,
        (face) => `${face.family} ${face.weight} ${face.style} ${face.status}`,
      ),
      families: [...families],
      blocks: perBlock,
      listWidth: document.querySelector<HTMLElement>('.messages-list')?.clientWidth ?? -1,
      listScroll: (() => {
        const l = document.querySelector<HTMLElement>('.messages-list')
        return l
          ? `${String(l.scrollTop)}/${String(l.scrollHeight)}/${String(l.clientHeight)}`
          : 'none'
      })(),
      geometry: Array.from(
        document.querySelectorAll<HTMLElement>(
          '.messages-list .message-text pre, .messages-list .message-text :not(pre) > code',
        ),
        (el) => {
          const r = el.getBoundingClientRect()
          const style = getComputedStyle(el)
          const parent = el.closest<HTMLElement>('.message-text')
          const pr = parent?.getBoundingClientRect()
          const wrapper = el.parentElement
          const lines = Math.round(r.height / (Number.parseFloat(style.lineHeight) || 1))
          if (el.tagName === 'CODE' && lines < 2) return ''
          return [
            el.tagName.toLowerCase(),
            `rect=${String(r.x)},${String(r.y)} ${String(r.width)}x${String(r.height)}`,
            `client=${String(el.clientWidth)} scroll=${String(el.scrollWidth)}`,
            `w=${style.width} lh=${style.lineHeight} fs=${style.fontSize} ws=${style.whiteSpace} ov=${style.overflowX}`,
            `pad=${style.paddingTop}/${style.paddingBottom} bd=${style.borderTopWidth}/${style.borderBottomWidth} mg=${style.marginTop}/${style.marginBottom}`,
            `parent=${pr ? `${String(pr.x)} ${String(pr.width)}x${String(pr.height)}` : 'none'}`,
            `wrap=${wrapper?.tagName.toLowerCase() ?? ''}.${(wrapper?.getAttribute('class') ?? '').replaceAll(' ', '.')} ${Array.from(
              wrapper?.attributes ?? [],
              (a) => a.name,
            )
              .filter((n) => n.startsWith('data-'))
              .join(',')}`,
            `self=.${(el.getAttribute('class') ?? '').replaceAll(' ', '.')} ${Array.from(
              el.attributes,
              (a) => a.name,
            )
              .filter((n) => n.startsWith('data-'))
              .join(',')}`,
          ].join(' | ')
        },
      ).filter((line) => line !== ''),
      rows: Array.from(
        document.querySelectorAll('.messages-list > .msg-assistant'),
        (row) => row.getBoundingClientRect().height,
      ),
      html: document.documentElement.getAttribute('class') ?? '',
      htmlAttrs: Array.from(
        document.documentElement.attributes,
        (a) => `${a.name}=${a.value.slice(0, 40)}`,
      ),
      sheets: document.styleSheets.length,
      events: document.documentElement.dataset['diagFontEvents'] ?? 'none',
    }
  })
  console.log(`[fontdiag ${filename} ${phase}] ${JSON.stringify(diag)}`)
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
    seedE2eViewport(AUTH_VIEWPORT)
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
    // TEMPORARY DIAGNOSTIC (revert before review): <html> attributes and <head>
    // insertions from the first settled transcript on.
    await browser.execute(() => {
      const events: string[] = []
      const record = (entry: string): void => {
        events.push(`${String(Math.round(performance.now()))} ${entry}`)
        document.documentElement.dataset['diagFontEvents'] = JSON.stringify(events.slice(-40))
      }
      new MutationObserver((records) => {
        for (const r of records) {
          if (r.attributeName === 'data-diag-font-events') continue
          record(
            `html@${r.attributeName ?? ''}=${(document.documentElement.getAttribute(r.attributeName ?? '') ?? '').slice(0, 40)}`,
          )
        }
      }).observe(document.documentElement, { attributes: true })
      new MutationObserver((records) => {
        for (const r of records) {
          for (const node of Array.from(r.addedNodes)) {
            if (node instanceof Element) {
              record(
                `head+${node.tagName.toLowerCase()} ${node.getAttribute('href') ?? node.getAttribute('src') ?? node.textContent.slice(0, 40)}`,
              )
            }
          }
        }
      }).observe(document.head, { childList: true, subtree: true })
      document.fonts.addEventListener('loadingdone', (event) => {
        record(
          `fonts-done ${event.fontfaces.map((face) => `${face.family}/${face.weight}`).join(',')}`,
        )
      })
      document.fonts.addEventListener('loading', () => {
        record('fonts-loading')
      })
      record('installed')
    })
  })

  after(() => {
    writeE2eEnv({ COPSE_PRESERVE_PATH: originalPreservePath, PATH: originalPath })
    resetUserData()
  })

  it('shows the dedicated Claude sign-in command in setup without adapter jargon', async () => {
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
    await expect(signIn.$('.acp-cmd')).toHaveText('claude auth login')
    const note = await $('.acp-known-agent-note')
    await expect(note).toHaveText(expect.stringContaining('claude auth login'))
    await expect(note).toHaveText(expect.stringContaining('ANTHROPIC_API_KEY'))
    await expect(note).not.toHaveText(expect.stringContaining('claude-agent-acp'))
    await expect(signIn).not.toHaveText(expect.stringContaining('--sso'))
    await expect($('#approval-dialog')).not.toBeDisplayed()
    await saveElementScreenshot('.acp-add-menu .provider-form', 'claude-sign-in.png')
  })

  it('leads with recovery and keeps opaque ACP diagnostics subordinate', async () => {
    const message = await $('[data-message-id="msg-assistant-acp-auth"] .message-text').getElement()
    const warning = await message.$('.markdown-alert-warning').getElement()
    await expect(warning.$('strong')).toHaveText('Claude sign-in expired')
    await expect(message.$('ol code')).toHaveText('claude auth login')
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
    expect(hints.inSteps).toEqual(['claude auth login'])
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
    await expect(message.$('ol code')).toHaveText('claude auth login')
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
})
