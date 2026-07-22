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

async function navigateActiveTab(url: string): Promise<void> {
  await browser.execute((targetUrl) => {
    const input = document.querySelector(
      '.browser-tab-panel.is-active .browser-url-input',
    ) as HTMLInputElement | null
    if (!input) return
    input.value = targetUrl
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const goBtn = document.querySelector(
      '.browser-tab-panel.is-active .browser-go-btn',
    ) as HTMLButtonElement | null
    goBtn?.click()
  }, url)
}

describe('browser Cursor agent URL navigation', () => {
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

  it('loads cursor.com/agents in the browser without switching threads', async function () {
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

    const agentsUrl = 'https://cursor.com/agents/bc-e2e-linked-agent'
    await navigateActiveTab(agentsUrl)

    // Address bar is set immediately on navigate — proves we did not short-circuit
    // into a thread handoff (which previously left the prior page in place).
    await browser.waitUntil(
      async () => {
        const value = await input.getValue()
        return value.includes('cursor.com/agents/bc-e2e-linked-agent')
      },
      { timeout: 10_000, timeoutMsg: 'expected the address bar to show the Cursor agents URL' },
    )

    // Guest may land on the agents page or Cursor's auth redirect; either proves
    // the webview was allowed to navigate instead of being cancelled.
    await browser.waitUntil(
      async () => {
        const url = await browser.execute(() => {
          const webview = document.querySelector('.browser-tab-panel.is-active webview') as {
            getURL(): string
          } | null
          return webview?.getURL() ?? ''
        })
        return (
          url.includes('cursor.com/agents/bc-e2e-linked-agent') ||
          url.includes('authenticator.cursor.sh') ||
          url.includes('cursor.com/api/auth')
        )
      },
      {
        timeout: 25_000,
        timeoutMsg: 'expected the guest webview to navigate toward Cursor agents/auth',
      },
    )

    // Linked-thread handoff is reserved for the PR pane button — chat/browser
    // navigation must not steal the active conversation.
    await expect($('.chat-row.selected .chat-title')).toHaveText('Review agent PR on GitHub')
    expect(await $$('.browser-tabs-tab')).toHaveLength(1)

    await saveAppScreenshot('browser-cursor-agent-url-navigation.png')
  })
})
