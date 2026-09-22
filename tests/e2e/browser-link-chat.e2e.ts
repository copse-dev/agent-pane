import type { WebviewTag } from 'electron'
import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedBrowserLinkChatFixture,
  seedE2eViewport,
  seedStableWorkspace,
} from './helpers/seed-config.ts'
import { startBrowserPageFixture } from './helpers/browser-page-fixture.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

async function waitForWebviewTitle(expected: string, timeoutMs = 25_000): Promise<void> {
  await browser.waitUntil(
    async () => {
      const title = await browser.execute(() => {
        const webview = document.querySelector<WebviewTag>('.browser-tab-panel.is-active webview')
        return webview && !webview.isLoading() ? webview.getTitle() : ''
      })
      return title.toLowerCase().includes(expected.toLowerCase())
    },
    {
      timeout: timeoutMs,
      timeoutMsg: `expected webview title to contain ${expected}`,
    },
  )
}

describe('chat browser links', () => {
  let page: Awaited<ReturnType<typeof startBrowserPageFixture>>

  before(async () => {
    resetUserData()
    seedE2eViewport()
    page = await startBrowserPageFixture(43121)
    seedBrowserLinkChatFixture(seedStableWorkspace(), page.url)
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(async () => {
    resetUserData()
    await page?.close()
  })

  it('opens chat links in the browser panel and navigates to the URL', async () => {
    const message = await $('[data-message-id="msg-assistant-link"] .message-text')
    await message.waitForDisplayed({ timeout: 30_000 })

    const link = await message.$('a')
    await link.waitForDisplayed({ timeout: 5_000 })
    await expect(link).toHaveAttribute('href', page.url)

    await link.click()

    await $('#pane-files').waitForDisplayed({ timeout: 5_000 })
    await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const host = document.getElementById('browser-viewer-host')
          return host != null && !host.hidden
        }),
      {
        timeout: 5_000,
        timeoutMsg: 'expected browser viewer to show',
      },
    )

    const urlInput = await $('.browser-tab-panel.is-active .browser-url-input')
    await urlInput.waitForDisplayed({ timeout: 5_000 })
    await expect(urlInput).toHaveValue(page.url)

    await waitForWebviewTitle('Copse browser fixture')
    expect(page.requests).toContain('/page')
    const heading = await browser.execute(async () => {
      const webview = document.querySelector<WebviewTag>('.browser-tab-panel.is-active webview')
      if (!webview) throw new Error('active browser webview missing')
      return webview.executeJavaScript("document.querySelector('h1')?.textContent")
    })
    expect(heading).toBe('Local browser page')
    await saveAppScreenshot('browser-link-chat-local-page.png')
  })
})
