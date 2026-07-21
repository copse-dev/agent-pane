import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import {
  resetUserData,
  seedBrowserCursorAgentThreadFixture,
  seedE2eThreePaneLayout,
  seedE2eViewport,
} from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

describe('browser Cursor agent thread handoff', () => {
  before(async function () {
    this.timeout(120_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    writeE2eEnv({
      COPSE_PANEL_MOCK_LLM: '1',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
    })
    resetUserData()
    seedBrowserCursorAgentThreadFixture(process.cwd())
    seedE2eViewport()
    seedE2eThreePaneLayout()
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
  })

  after(() => {
    resetUserData()
  })

  it('selects the local thread without leaving the previous browser page', async function () {
    this.timeout(120_000)

    await expect($('.chat-row.selected .chat-title')).toHaveText('Review agent PR on GitHub')
    await $('.titlebar-btn[aria-label="Open browser"]').click()
    const input = await $('.browser-tab-panel.is-active .browser-url-input')
    await input.waitForDisplayed({ timeout: 10_000 })
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => {
          const webview = document.querySelector('.browser-tab-panel.is-active webview') as {
            getURL(): string
          } | null
          return webview?.getURL() ?? ''
        })) === 'about:blank',
      { timeout: 10_000, timeoutMsg: 'expected the initial browser page to finish attaching' },
    )
    const previousUrl = await browser.execute(() => {
      const webview = document.querySelector('.browser-tab-panel.is-active webview') as {
        getURL(): string
      } | null
      return webview?.getURL() ?? ''
    })

    // Exercise a real same-tab link inside the guest (the GitHub-page path),
    // rather than the address bar's host-side navigation shortcut.
    await browser.execute(async (cursorUrl) => {
      const webview = document.querySelector('.browser-tab-panel.is-active webview') as {
        executeJavaScript(script: string): Promise<unknown>
      } | null
      if (!webview) return
      await webview.executeJavaScript(
        `const link = document.createElement('a'); link.href = ${JSON.stringify(cursorUrl)}; document.body.append(link); link.click();`,
      )
    }, 'https://cursor.com/agents/bc-e2e-linked-agent?from=github')

    await expect($('.chat-row.selected .chat-title')).toHaveText('Implement browser handoff')
    await expect($('[data-message-id="msg-linked-cursor-run"]')).toBeDisplayed()
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => {
          const webview = document.querySelector('.browser-tab-panel.is-active webview') as {
            getURL(): string
          } | null
          return webview?.getURL() ?? ''
        })) === previousUrl,
      { timeout: 10_000, timeoutMsg: 'expected the browser to remain on the previous page' },
    )
    await expect(input).toHaveValue('')
    expect(await $$('.browser-tabs-tab')).toHaveLength(1)

    await saveAppScreenshot('browser-cursor-agent-thread-handoff.png')
  })
})
