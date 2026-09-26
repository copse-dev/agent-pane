import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import {
  resetUserData,
  seedBrowserCursorAgentThreadFixture,
  seedStableWorkspace,
} from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

/** The parts of Electron's `<webview>` element this spec drives. */
interface Guest extends HTMLElement {
  getURL(): string
  stop(): void
}

const AGENTS_URL = 'https://cursor.com/agents/bc-e2e-linked-agent'

async function navigateActiveTab(url: string): Promise<void> {
  await browser.execute((targetUrl) => {
    const input = document.querySelector<HTMLInputElement>(
      '.browser-tab-panel.is-active .browser-url-input',
    )
    if (!input) return
    input.value = targetUrl
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document
      .querySelector<HTMLButtonElement>('.browser-tab-panel.is-active .browser-go-btn')
      ?.click()
  }, url)
}

/**
 * Record every main-frame navigation the active guest starts, and stop the one
 * to `stopAtUrl` as soon as it starts.
 *
 * `did-start-navigation` fires once the guest has accepted the navigation and
 * before its response arrives, so it proves the URL went to the browser guest
 * rather than being intercepted as a thread handoff — without depending on
 * cursor.com, its redirects, its auth flow or the runner's network. Stopping
 * there keeps the live page, and any slow or hung connection to it, out of the
 * assertions and the screenshot.
 */
async function recordGuestNavigations(stopAtUrl: string): Promise<void> {
  await browser.execute((expected) => {
    const guest = document.querySelector<Guest>('.browser-tab-panel.is-active webview')
    if (!guest) throw new Error('missing browser guest')
    guest.dataset.e2eMainFrameStarts = ''
    guest.addEventListener('did-start-navigation', (event) => {
      if (!('url' in event) || typeof event.url !== 'string') return
      if (!('isMainFrame' in event) || event.isMainFrame !== true) return
      guest.dataset.e2eMainFrameStarts = `${guest.dataset.e2eMainFrameStarts ?? ''}${event.url}\n`
      if (event.url === expected) guest.stop()
    })
  }, stopAtUrl)
}

async function guestMainFrameStarts(): Promise<string[]> {
  const log = await browser.execute(
    () =>
      document.querySelector<Guest>('.browser-tab-panel.is-active webview')?.dataset
        .e2eMainFrameStarts ?? '',
  )
  return log.split('\n').filter(Boolean)
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
    seedBrowserCursorAgentThreadFixture(seedStableWorkspace())
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
  })

  after(() => {
    resetUserData()
  })

  it('navigates the browser guest to cursor.com/agents without switching threads', async function () {
    this.timeout(120_000)

    await expect($('.chat-row.selected .chat-title')).toHaveText('Review agent PR on GitHub')
    await $('.titlebar-btn[aria-label="Open browser"]').click()
    const input = await $('.browser-tab-panel.is-active .browser-url-input')
    await input.waitForDisplayed({ timeout: 10_000 })
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () =>
            document.querySelector<Guest>('.browser-tab-panel.is-active webview')?.getURL() ?? '',
        )) === 'about:blank',
      { timeout: 10_000, timeoutMsg: 'expected the initial browser page to finish attaching' },
    )

    await recordGuestNavigations(AGENTS_URL)
    await navigateActiveTab(AGENTS_URL)

    // The pane keeps the requested URL in the address bar rather than resetting it
    // to the page a thread handoff would have left in place.
    await browser.waitUntil(async () => (await input.getValue()) === AGENTS_URL, {
      timeout: 10_000,
      timeoutMsg: 'expected the address bar to show the Cursor agents URL',
    })

    // The guest itself started the main-frame navigation to the agents URL: it
    // was handed to the webview instead of being cancelled or rerouted. Whether
    // cursor.com then answers, redirects to sign-in or times out is not this
    // spec's concern.
    await browser.waitUntil(async () => (await guestMainFrameStarts()).includes(AGENTS_URL), {
      timeout: 10_000,
      timeoutMsg: 'expected the browser guest to start navigating to the Cursor agents URL',
    })

    // Linked-thread handoff is reserved for the PR pane button — chat/browser
    // navigation must not steal the active conversation or spawn another tab.
    await expect($('.chat-row.selected .chat-title')).toHaveText('Review agent PR on GitHub')
    expect(await $$('.browser-tabs-tab')).toHaveLength(1)
    expect(await guestMainFrameStarts()).toEqual([AGENTS_URL])
    // Nor did the browser network policy deny the request once it started.
    expect(await input.getAttribute('class')).not.toContain('has-blocked')

    await saveAppScreenshot('browser-cursor-agent-url-navigation.png')
  })
})
